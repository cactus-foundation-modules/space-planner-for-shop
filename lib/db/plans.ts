import { randomBytes, timingSafeEqual } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { PlanItems, ProductSnapshot, SplPlan, SplPlanVersion } from '@/modules/space-planner-for-shop/lib/types'
import { readPlanItems, readProductSnapshot } from '@/modules/space-planner-for-shop/lib/validation'

// Every spl_plans and spl_plan_versions read and write.
//
// As with rooms, the ownership rule lives in the WHERE clause and there is no
// function here that reads a plan without being told whose it is - except
// getPlanByShareToken, which is the deliberate exception and takes a secret
// instead of an id.

type PlanRow = {
  id: string
  room_id: string
  member_id: string | null
  owner_user_id: string | null
  name: string
  position: number
  items: unknown
  product_snapshot: unknown
  share_token: string | null
  schema_version: number
  thumbnail_media_id: string | null
  quote_id: string | null
  created_at: Date
  updated_at: Date
}

function toPlan(row: PlanRow): SplPlan {
  return {
    id: row.id,
    roomId: row.room_id,
    memberId: row.member_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    position: row.position,
    items: readPlanItems(row.items),
    productSnapshot: readProductSnapshot(row.product_snapshot) as ProductSnapshot,
    shareToken: row.share_token,
    schemaVersion: row.schema_version,
    thumbnailMediaId: row.thumbnail_media_id,
    quoteId: row.quote_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listPlansForRoom(roomId: string, memberId: string): Promise<SplPlan[]> {
  const rows = await prisma.$queryRaw<PlanRow[]>`
    SELECT * FROM "spl_plans"
    WHERE "room_id" = ${roomId} AND "member_id" = ${memberId}
    ORDER BY "position" ASC, "created_at" ASC
  `
  return rows.map(toPlan)
}

export async function listPlansForMember(memberId: string, limit = 200): Promise<SplPlan[]> {
  const rows = await prisma.$queryRaw<PlanRow[]>`
    SELECT * FROM "spl_plans" WHERE "member_id" = ${memberId}
    ORDER BY "updated_at" DESC LIMIT ${limit}
  `
  return rows.map(toPlan)
}

export async function getPlanForMember(planId: string, memberId: string): Promise<SplPlan | null> {
  const rows = await prisma.$queryRaw<PlanRow[]>`
    SELECT * FROM "spl_plans" WHERE "id" = ${planId} AND "member_id" = ${memberId} LIMIT 1
  `
  return rows[0] ? toPlan(rows[0]) : null
}

export async function getPlanForAdmin(planId: string): Promise<SplPlan | null> {
  const rows = await prisma.$queryRaw<PlanRow[]>`SELECT * FROM "spl_plans" WHERE "id" = ${planId} LIMIT 1`
  return rows[0] ? toPlan(rows[0]) : null
}

export async function countPlansInRoom(roomId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "spl_plans" WHERE "room_id" = ${roomId}
  `
  return Number(rows[0]?.count ?? 0)
}

export async function createPlan(input: {
  roomId: string
  memberId: string
  name: string
  items: PlanItems
  productSnapshot: ProductSnapshot
}): Promise<SplPlan> {
  const rows = await prisma.$queryRaw<PlanRow[]>`
    INSERT INTO "spl_plans" ("room_id", "member_id", "name", "position", "items", "product_snapshot", "schema_version")
    VALUES (
      ${input.roomId},
      ${input.memberId},
      ${input.name},
      COALESCE((SELECT MAX("position") + 1 FROM "spl_plans" WHERE "room_id" = ${input.roomId}), 0),
      ${JSON.stringify(input.items)}::jsonb,
      ${JSON.stringify(input.productSnapshot)}::jsonb,
      ${input.items.version}
    )
    RETURNING *
  `
  const row = rows[0]
  if (!row) throw new Error('Could not save that plan.')
  return toPlan(row)
}

export async function updatePlan(
  planId: string,
  memberId: string,
  patch: {
    name?: string
    items?: PlanItems
    productSnapshot?: ProductSnapshot
    position?: number
    thumbnailMediaId?: string | null
    quoteId?: string | null
  },
): Promise<SplPlan | null> {
  const current = await getPlanForMember(planId, memberId)
  if (!current) return null

  // Only the columns actually named in the patch are written. It used to write
  // every column back from the row it had just read, so a small patch carried a
  // full copy of a snapshot taken moments earlier: asking for a quote (which
  // patches nothing but quote_id) would put back the furniture as it stood when
  // the quote route started, quietly undoing a save that landed in between.
  const name = patch.name ?? current.name
  const items = patch.items ?? current.items
  const snapshot = patch.productSnapshot ?? current.productSnapshot
  const position = patch.position ?? current.position
  const thumbnail = patch.thumbnailMediaId === undefined ? current.thumbnailMediaId : patch.thumbnailMediaId
  const quoteId = patch.quoteId === undefined ? current.quoteId : patch.quoteId

  const rows = await prisma.$queryRaw<PlanRow[]>`
    UPDATE "spl_plans"
    SET "name" = ${patch.name === undefined ? Prisma.sql`"name"` : Prisma.sql`${name}`},
        "items" = ${patch.items === undefined ? Prisma.sql`"items"` : Prisma.sql`${JSON.stringify(items)}::jsonb`},
        "product_snapshot" = ${patch.productSnapshot === undefined ? Prisma.sql`"product_snapshot"` : Prisma.sql`${JSON.stringify(snapshot)}::jsonb`},
        "position" = ${patch.position === undefined ? Prisma.sql`"position"` : Prisma.sql`${position}`},
        "thumbnail_media_id" = ${patch.thumbnailMediaId === undefined ? Prisma.sql`"thumbnail_media_id"` : Prisma.sql`${thumbnail}`},
        "quote_id" = ${patch.quoteId === undefined ? Prisma.sql`"quote_id"` : Prisma.sql`${quoteId}`},
        "schema_version" = ${patch.items === undefined ? Prisma.sql`"schema_version"` : Prisma.sql`${items.version}`},
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${planId} AND "member_id" = ${memberId}
    RETURNING *
  `
  return rows[0] ? toPlan(rows[0]) : null
}

export async function deletePlan(planId: string, memberId: string): Promise<boolean> {
  const count = await prisma.$executeRaw`
    DELETE FROM "spl_plans" WHERE "id" = ${planId} AND "member_id" = ${memberId}
  `
  return count > 0
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/**
 * Mint a share token on demand.
 *
 * Nothing has a token until somebody presses share, so there is no token to leak
 * for a plan nobody shared. Revoking sets it back to null, which is what makes
 * the link stop working immediately rather than eventually.
 */
export async function setPlanShare(planId: string, memberId: string, shared: boolean): Promise<string | null> {
  const token = shared ? randomBytes(24).toString('base64url') : null
  const rows = await prisma.$queryRaw<{ share_token: string | null }[]>`
    UPDATE "spl_plans"
    SET "share_token" = ${token}, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${planId} AND "member_id" = ${memberId}
    RETURNING "share_token"
  `
  return rows[0]?.share_token ?? null
}

/**
 * The one reader that takes a secret rather than an owner.
 *
 * The lookup is by exact token in SQL, and the constant-time comparison
 * afterwards is belt and braces against a timing oracle on the database's own
 * index. Tokens are 192 bits of randomness, so this is cheap insurance rather
 * than the main defence.
 */
export async function getPlanByShareToken(token: string): Promise<SplPlan | null> {
  if (!token || token.length > 128) return null
  const rows = await prisma.$queryRaw<PlanRow[]>`
    SELECT * FROM "spl_plans" WHERE "share_token" = ${token} LIMIT 1
  `
  const row = rows[0]
  if (!row?.share_token) return null
  const a = Buffer.from(row.share_token)
  const b = Buffer.from(token)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return toPlan(row)
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

type VersionRow = {
  id: string
  plan_id: string
  version: number
  items: unknown
  product_snapshot: unknown
  label: string | null
  created_at: Date
}

function toVersion(row: VersionRow): SplPlanVersion {
  return {
    id: row.id,
    planId: row.plan_id,
    version: row.version,
    items: readPlanItems(row.items),
    productSnapshot: readProductSnapshot(row.product_snapshot) as ProductSnapshot,
    label: row.label,
    createdAt: row.created_at,
  }
}

export async function listPlanVersions(planId: string): Promise<SplPlanVersion[]> {
  const rows = await prisma.$queryRaw<VersionRow[]>`
    SELECT * FROM "spl_plan_versions" WHERE "plan_id" = ${planId} ORDER BY "version" DESC
  `
  return rows.map(toVersion)
}

export async function getPlanVersion(planId: string, version: number): Promise<SplPlanVersion | null> {
  const rows = await prisma.$queryRaw<VersionRow[]>`
    SELECT * FROM "spl_plan_versions" WHERE "plan_id" = ${planId} AND "version" = ${version} LIMIT 1
  `
  return rows[0] ? toVersion(rows[0]) : null
}

/**
 * Archive the plan as it stands, before it is replaced.
 *
 * Called on every explicit save and before every operation that is destructive
 * by nature. Restoring a version goes back through the ordinary save path, so a
 * restore archives what it replaced automatically - core's Layout history works
 * exactly this way, and the reason is the same: "restoring a published layout IS
 * publishing".
 *
 * The version number is worked out inside the INSERT, so two saves landing
 * together both choose the same one and the loser hits the unique key. That is
 * dropped rather than raised: both were archiving the identical state, so the
 * archive is already correct - and a five hundred over an unwanted duplicate
 * copy would fail a member's save for no reason they could act on.
 */
export async function archivePlanVersion(plan: SplPlan, cap: number, label?: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "spl_plan_versions" ("plan_id", "version", "items", "product_snapshot", "label")
    VALUES (
      ${plan.id},
      COALESCE((SELECT MAX("version") + 1 FROM "spl_plan_versions" WHERE "plan_id" = ${plan.id}), 1),
      ${JSON.stringify(plan.items)}::jsonb,
      ${JSON.stringify(plan.productSnapshot)}::jsonb,
      ${label ?? null}
    )
    ON CONFLICT ("plan_id", "version") DO NOTHING
  `
  // Keep the last N, plus anything the member has labelled. A labelled version is
  // one somebody deliberately kept, so the cap does not get to decide about it.
  await prisma.$executeRaw`
    DELETE FROM "spl_plan_versions"
    WHERE "plan_id" = ${plan.id}
      AND "label" IS NULL
      AND "id" NOT IN (
        SELECT "id" FROM "spl_plan_versions"
        WHERE "plan_id" = ${plan.id} AND "label" IS NULL
        ORDER BY "version" DESC
        LIMIT ${cap}
      )
  `
}

export async function labelPlanVersion(planId: string, version: number, label: string | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "spl_plan_versions" SET "label" = ${label}
    WHERE "plan_id" = ${planId} AND "version" = ${version}
  `
}

// ---------------------------------------------------------------------------
// Admin and housekeeping
// ---------------------------------------------------------------------------

export type AdminPlanRow = {
  plan: SplPlan
  roomName: string
  memberUsername: string | null
  memberEmail: string | null
}

export async function listPlansForAdmin(opts: { page?: number; perPage?: number; search?: string } = {}): Promise<{ rows: AdminPlanRow[]; total: number }> {
  const page = Math.max(1, Math.floor(Number(opts.page)) || 1)
  const perPage = Math.min(100, Math.max(1, Math.floor(Number(opts.perPage)) || 25))
  const offset = (page - 1) * perPage
  const search = (opts.search ?? '').trim()
  // The wildcards are ours, so the typed text must not be allowed to add its
  // own: a search for "50%" matched every plan in the shop, and one for "_"
  // matched every plan whose name was one character long plus every other plan
  // as well. Backslash is Postgres's default ILIKE escape, so it goes first.
  const like = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`

  const rows = search
    ? await prisma.$queryRaw<Array<PlanRow & { room_name: string; username: string | null; email: string | null }>>`
        SELECT p.*, r."name" AS room_name, m."username", m."email"
        FROM "spl_plans" p
        JOIN "spl_rooms" r ON r."id" = p."room_id"
        LEFT JOIN "Member" m ON m."id" = p."member_id"
        WHERE p."name" ILIKE ${like} OR r."name" ILIKE ${like} OR m."username" ILIKE ${like} OR m."email" ILIKE ${like}
        ORDER BY p."updated_at" DESC LIMIT ${perPage} OFFSET ${offset}
      `
    : await prisma.$queryRaw<Array<PlanRow & { room_name: string; username: string | null; email: string | null }>>`
        SELECT p.*, r."name" AS room_name, m."username", m."email"
        FROM "spl_plans" p
        JOIN "spl_rooms" r ON r."id" = p."room_id"
        LEFT JOIN "Member" m ON m."id" = p."member_id"
        ORDER BY p."updated_at" DESC LIMIT ${perPage} OFFSET ${offset}
      `

  const countRows = search
    ? await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "spl_plans" p
        JOIN "spl_rooms" r ON r."id" = p."room_id"
        LEFT JOIN "Member" m ON m."id" = p."member_id"
        WHERE p."name" ILIKE ${like} OR r."name" ILIKE ${like} OR m."username" ILIKE ${like} OR m."email" ILIKE ${like}
      `
    : await prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*)::bigint AS count FROM "spl_plans"`

  return {
    rows: rows.map((row) => ({
      plan: toPlan(row),
      roomName: row.room_name,
      memberUsername: row.username,
      memberEmail: row.email,
    })),
    total: Number(countRows[0]?.count ?? 0),
  }
}

export async function deletePlanForAdmin(planId: string): Promise<boolean> {
  const count = await prisma.$executeRaw`DELETE FROM "spl_plans" WHERE "id" = ${planId}`
  return count > 0
}
