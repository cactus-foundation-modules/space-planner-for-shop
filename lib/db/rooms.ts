import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { defaultRoomGeometry } from '@/modules/space-planner-for-shop/lib/types'
import type { RoomGeometry, SplRoom } from '@/modules/space-planner-for-shop/lib/types'
import { readRoomGeometry } from '@/modules/space-planner-for-shop/lib/validation'

// Every spl_rooms read and write. Raw SQL through Prisma, like every other
// module's own tables - prisma/schema.prisma has never heard of these.
//
// The ownership rule is enforced HERE, in the WHERE clause, rather than in the
// routes. A plan id is not a capability: fetching, editing or deleting a room
// has to prove the session owns it, and the reliable way to guarantee that is
// for there to be no function in this file that can read a room without being
// told whose it is. `getRoomForMember` is the only reader, and it takes a member
// id. That is the whole defence, and it is deliberately boring.

type RoomRow = {
  id: string
  member_id: string | null
  owner_user_id: string | null
  name: string
  notes: string
  geometry: unknown
  schema_version: number
  thumbnail_media_id: string | null
  created_at: Date
  updated_at: Date
}

function toRoom(row: RoomRow): SplRoom {
  return {
    id: row.id,
    memberId: row.member_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    notes: row.notes,
    geometry: readRoomGeometry(row.geometry, defaultRoomGeometry()),
    schemaVersion: row.schema_version,
    thumbnailMediaId: row.thumbnail_media_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export type RoomSummary = {
  room: SplRoom
  planCount: number
  lastEditedAt: Date
}

/** Every room this member owns, newest activity first, with its plan count. */
export async function listRoomsForMember(memberId: string): Promise<RoomSummary[]> {
  const rows = await prisma.$queryRaw<Array<RoomRow & { plan_count: bigint; last_plan_at: Date | null }>>`
    SELECT r.*,
           COUNT(p."id")::bigint AS plan_count,
           MAX(p."updated_at") AS last_plan_at
    FROM "spl_rooms" r
    LEFT JOIN "spl_plans" p ON p."room_id" = r."id"
    WHERE r."member_id" = ${memberId}
    GROUP BY r."id"
    ORDER BY GREATEST(r."updated_at", COALESCE(MAX(p."updated_at"), r."updated_at")) DESC
  `
  return rows.map((row) => ({
    room: toRoom(row),
    planCount: Number(row.plan_count),
    lastEditedAt: row.last_plan_at && row.last_plan_at > row.updated_at ? row.last_plan_at : row.updated_at,
  }))
}

export async function countRoomsForMember(memberId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "spl_rooms" WHERE "member_id" = ${memberId}
  `
  return Number(rows[0]?.count ?? 0)
}

/** The only room reader. Returns null when the room is missing OR not theirs. */
export async function getRoomForMember(roomId: string, memberId: string): Promise<SplRoom | null> {
  const rows = await prisma.$queryRaw<RoomRow[]>`
    SELECT * FROM "spl_rooms" WHERE "id" = ${roomId} AND "member_id" = ${memberId} LIMIT 1
  `
  return rows[0] ? toRoom(rows[0]) : null
}

/** Staff-side read for the admin screens, which have their own permission gate. */
export async function getRoomForAdmin(roomId: string): Promise<SplRoom | null> {
  const rows = await prisma.$queryRaw<RoomRow[]>`SELECT * FROM "spl_rooms" WHERE "id" = ${roomId} LIMIT 1`
  return rows[0] ? toRoom(rows[0]) : null
}

export async function createRoom(input: {
  memberId: string
  name: string
  notes?: string
  geometry: RoomGeometry
}): Promise<SplRoom> {
  const rows = await prisma.$queryRaw<RoomRow[]>`
    INSERT INTO "spl_rooms" ("member_id", "name", "notes", "geometry", "schema_version")
    VALUES (
      ${input.memberId},
      ${input.name},
      ${input.notes ?? ''},
      ${JSON.stringify(input.geometry)}::jsonb,
      ${input.geometry.version}
    )
    RETURNING *
  `
  const row = rows[0]
  if (!row) throw new Error('Could not save that space.')
  return toRoom(row)
}

export async function updateRoom(
  roomId: string,
  memberId: string,
  patch: { name?: string; notes?: string; geometry?: RoomGeometry; thumbnailMediaId?: string | null },
): Promise<SplRoom | null> {
  const current = await getRoomForMember(roomId, memberId)
  if (!current) return null

  const name = patch.name ?? current.name
  const notes = patch.notes ?? current.notes
  const geometry = patch.geometry ?? current.geometry
  const thumbnail = patch.thumbnailMediaId === undefined ? current.thumbnailMediaId : patch.thumbnailMediaId

  const rows = await prisma.$queryRaw<RoomRow[]>`
    UPDATE "spl_rooms"
    SET "name" = ${name},
        "notes" = ${notes},
        -- Left alone when the caller did not send one, the same way updatePlan
        -- guards every one of its columns.
        --
        -- Writing it back "unchanged" is not harmless: what goes back is the
        -- geometry as READ, and the reader substitutes a plain 4m x 3m box on
        -- any parse failure. So a rollback after a schema-version bump made
        -- newer rooms unreadable, and then a customer simply RENAMING one
        -- overwrote their measured space with the default, permanently. Zod
        -- also strips keys it does not know, so every rename quietly dropped
        -- any geometry field the running build had not heard of.
        "geometry" = ${patch.geometry === undefined ? Prisma.sql`"geometry"` : Prisma.sql`${JSON.stringify(geometry)}::jsonb`},
        "schema_version" = ${patch.geometry === undefined ? Prisma.sql`"schema_version"` : Prisma.sql`${geometry.version}`},
        "thumbnail_media_id" = ${thumbnail},
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${roomId} AND "member_id" = ${memberId}
    RETURNING *
  `
  return rows[0] ? toRoom(rows[0]) : null
}

/**
 * Delete a room and everything in it. The plans go by cascade; the caller is
 * expected to have told the member how many that is, by name, first - "delete
 * room" reading as "delete one drawing" and taking four layouts with it is the
 * kind of surprise people do not forgive.
 */
export async function deleteRoom(roomId: string, memberId: string): Promise<boolean> {
  const count = await prisma.$executeRaw`
    DELETE FROM "spl_rooms" WHERE "id" = ${roomId} AND "member_id" = ${memberId}
  `
  return count > 0
}

/**
 * Rooms whose owning member no longer exists.
 *
 * Core owns the Member table and this module cannot foreign-key to it, so
 * account deletion does not cascade here on its own. Orphaned personal data
 * after a deletion request is a compliance failure rather than a bug, so the
 * nightly sweep asks this question every night and acts on the answer, instead
 * of the module assuming somebody else handled it.
 */
export async function deleteOrphanedRooms(): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "spl_rooms"
    WHERE "member_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "Member" m WHERE m."id" = "spl_rooms"."member_id")
  `
}

/** Rooms nobody has touched in a long while, for the owner to look at. Never auto-deleted. */
export async function listIdleRooms(months: number, limit = 100): Promise<SplRoom[]> {
  if (months <= 0) return []
  const cutoff = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000)
  const rows = await prisma.$queryRaw<RoomRow[]>`
    SELECT r.* FROM "spl_rooms" r
    WHERE r."updated_at" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "spl_plans" p WHERE p."room_id" = r."id" AND p."updated_at" >= ${cutoff}
      )
    ORDER BY r."updated_at" ASC
    LIMIT ${limit}
  `
  return rows.map(toRoom)
}
