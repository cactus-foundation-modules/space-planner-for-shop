import { randomBytes } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import type { BackfillStatus, RenderStatus, SplBackfillJob, SplRenderJob } from '@/modules/space-planner-for-shop/lib/types'

// Two job tables, both for the same reason: every module API route shares an
// un-overridable sixty-second ceiling, and background work started with after()
// gets starved along with it. Anything that cannot finish inside that ceiling
// banks its state in a row and is driven from outside.

// ---------------------------------------------------------------------------
// Dimension rebuild
// ---------------------------------------------------------------------------

type BackfillRow = {
  id: string
  kind: string
  status: string
  cursor: number
  total: number
  resolved_count: number
  skipped_count: number
  failed_count: number
  error: string
  started_at: Date | null
  finished_at: Date | null
  created_at: Date
  updated_at: Date
}

function toBackfill(row: BackfillRow): SplBackfillJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as BackfillStatus,
    cursor: row.cursor,
    total: row.total,
    resolvedCount: row.resolved_count,
    skippedCount: row.skipped_count,
    failedCount: row.failed_count,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The one job that is allowed to be live. A second rebuild would fight the first. */
export async function getActiveBackfill(): Promise<SplBackfillJob | null> {
  const rows = await prisma.$queryRaw<BackfillRow[]>`
    SELECT * FROM "spl_backfill_jobs" WHERE "status" IN ('QUEUED', 'RUNNING')
    ORDER BY "created_at" DESC LIMIT 1
  `
  return rows[0] ? toBackfill(rows[0]) : null
}

export async function getLatestBackfill(): Promise<SplBackfillJob | null> {
  const rows = await prisma.$queryRaw<BackfillRow[]>`
    SELECT * FROM "spl_backfill_jobs" ORDER BY "created_at" DESC LIMIT 1
  `
  return rows[0] ? toBackfill(rows[0]) : null
}

export async function getBackfill(id: string): Promise<SplBackfillJob | null> {
  const rows = await prisma.$queryRaw<BackfillRow[]>`SELECT * FROM "spl_backfill_jobs" WHERE "id" = ${id} LIMIT 1`
  return rows[0] ? toBackfill(rows[0]) : null
}

export async function createBackfill(total: number, kind = 'dimensions'): Promise<SplBackfillJob> {
  const rows = await prisma.$queryRaw<BackfillRow[]>`
    INSERT INTO "spl_backfill_jobs" ("kind", "status", "total") VALUES (${kind}, 'QUEUED', ${total})
    RETURNING *
  `
  const row = rows[0]
  if (!row) throw new Error('Could not start the rebuild.')
  return toBackfill(row)
}

export async function advanceBackfill(
  id: string,
  patch: { cursor: number; resolved: number; skipped: number; failed: number; done: boolean; error?: string },
): Promise<SplBackfillJob | null> {
  const rows = await prisma.$queryRaw<BackfillRow[]>`
    UPDATE "spl_backfill_jobs"
    SET "cursor" = ${patch.cursor},
        "resolved_count" = "resolved_count" + ${patch.resolved},
        "skipped_count" = "skipped_count" + ${patch.skipped},
        "failed_count" = "failed_count" + ${patch.failed},
        "status" = ${patch.done ? (patch.error ? 'FAILED' : 'DONE') : 'RUNNING'},
        "error" = ${patch.error ?? ''},
        "started_at" = COALESCE("started_at", CURRENT_TIMESTAMP),
        "finished_at" = ${patch.done ? new Date() : null},
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "status" IN ('QUEUED', 'RUNNING')
    RETURNING *
  `
  return rows[0] ? toBackfill(rows[0]) : null
}

/**
 * The stop button.
 *
 * Checked once per chunk rather than once per job, so pressing it stops the
 * rebuild within a few seconds instead of at the end - which is the difference
 * between a stop button and a decoration.
 */
export async function cancelBackfill(id: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "spl_backfill_jobs"
    SET "status" = 'CANCELLED', "finished_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "status" IN ('QUEUED', 'RUNNING')
  `
}

/**
 * Put the most recently stopped rebuild back in the queue at the cursor it
 * stopped on.
 *
 * Stopping is a pause, not an abandonment - that is what the button promises,
 * and over twenty thousand products a fresh job at cursor zero throws away
 * however long the last pass ran for. Cancelled rows are invisible to
 * getActiveBackfill on purpose (they are not live), so the resume is claimed
 * here, in one statement, rather than by reading a row and then writing it.
 */
export async function resumeStoppedBackfill(): Promise<SplBackfillJob | null> {
  const rows = await prisma.$queryRaw<BackfillRow[]>`
    UPDATE "spl_backfill_jobs"
    SET "status" = 'QUEUED', "finished_at" = NULL, "error" = '', "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = (
      SELECT "id" FROM "spl_backfill_jobs"
      WHERE "status" = 'CANCELLED' AND "cursor" < "total"
      ORDER BY "created_at" DESC LIMIT 1
    )
    RETURNING *
  `
  return rows[0] ? toBackfill(rows[0]) : null
}

// ---------------------------------------------------------------------------
// Renders
// ---------------------------------------------------------------------------

type RenderRow = {
  id: string
  plan_id: string
  member_id: string | null
  status: string
  params: unknown
  plan_updated_at: Date | null
  result_media_id: string | null
  result_url: string
  error: string
  machine_id: string
  callback_token: string
  started_at: Date | null
  finished_at: Date | null
  created_at: Date
  updated_at: Date
}

function toRender(row: RenderRow): SplRenderJob {
  return {
    id: row.id,
    planId: row.plan_id,
    memberId: row.member_id,
    status: row.status as RenderStatus,
    params: (row.params ?? {}) as Record<string, unknown>,
    planUpdatedAt: row.plan_updated_at,
    resultMediaId: row.result_media_id,
    resultUrl: row.result_url,
    error: row.error,
    machineId: row.machine_id ?? '',
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function getLiveRenderForPlan(planId: string): Promise<SplRenderJob | null> {
  const rows = await prisma.$queryRaw<RenderRow[]>`
    SELECT * FROM "spl_render_jobs" WHERE "plan_id" = ${planId} AND "status" IN ('QUEUED', 'RUNNING')
    ORDER BY "created_at" DESC LIMIT 1
  `
  return rows[0] ? toRender(rows[0]) : null
}

export async function listRendersForPlan(planId: string, limit = 20): Promise<SplRenderJob[]> {
  const rows = await prisma.$queryRaw<RenderRow[]>`
    SELECT * FROM "spl_render_jobs" WHERE "plan_id" = ${planId}
    ORDER BY "created_at" DESC LIMIT ${limit}
  `
  return rows.map(toRender)
}

export async function getRenderJob(id: string): Promise<SplRenderJob | null> {
  const rows = await prisma.$queryRaw<RenderRow[]>`SELECT * FROM "spl_render_jobs" WHERE "id" = ${id} LIMIT 1`
  return rows[0] ? toRender(rows[0]) : null
}

/**
 * Thrown when this plan already has a picture on the way.
 *
 * The route looks before it books, but two taps inside the same second both
 * looked and both found nothing - and a picture is the one thing in this module
 * with a meter running on it. The partial unique index added in migration 004 is
 * what actually decides, and this is that refusal in a form the route can answer
 * politely rather than as a five hundred.
 */
export class RenderAlreadyLiveError extends Error {
  constructor() {
    super('A picture of this layout is already being made.')
    this.name = 'RenderAlreadyLiveError'
  }
}

export async function createRenderJob(input: {
  planId: string
  memberId: string | null
  params: Record<string, unknown>
  planUpdatedAt: Date
}): Promise<SplRenderJob> {
  const token = randomBytes(24).toString('base64url')
  // The conflict is handled by the INSERT rather than by catching the error it
  // would otherwise raise. Prisma does not pass a raw query's SQLSTATE through
  // as `error.code` - that reads 'P2010', with the 23505 buried in the message -
  // so a catch written against 23505 never fires, and the second of two taps
  // would answer a five hundred instead of the picture already being made.
  const rows = await prisma.$queryRaw<RenderRow[]>`
    INSERT INTO "spl_render_jobs" ("plan_id", "member_id", "params", "plan_updated_at", "callback_token")
    VALUES (${input.planId}, ${input.memberId}, ${JSON.stringify(input.params)}::jsonb, ${input.planUpdatedAt}, ${token})
    ON CONFLICT ("plan_id") WHERE "status" IN ('QUEUED', 'RUNNING') DO NOTHING
    RETURNING *
  `
  const row = rows[0]
  if (!row) throw new RenderAlreadyLiveError()
  return toRender(row)
}

/**
 * How many pictures this member has asked for lately.
 *
 * Counted off the jobs themselves rather than off the event log. The log carries
 * no member column, so the limit used to be counted against the member's CURRENT
 * plan ids - and deleting a plan orphaned its events and handed back a full
 * allowance. A member may delete their own plans whenever they like; they should
 * not be able to buy machine time by doing it.
 */
export async function countRecentRendersForMember(memberId: string, windowMinutes: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "spl_render_jobs"
    WHERE "member_id" = ${memberId}
      AND "started_at" IS NOT NULL
      AND "created_at" > CURRENT_TIMESTAMP - (${windowMinutes} * INTERVAL '1 minute')
  `
  return Number(rows[0]?.count ?? 0)
}

/** The per-job secret the worker echoes back, so a finished-job POST cannot be forged. */
export async function getRenderCallbackToken(id: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ callback_token: string }[]>`
    SELECT "callback_token" FROM "spl_render_jobs" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0]?.callback_token ?? null
}

/** Remember which machine is doing this one. Written the moment Fly hands the
 * machine over, BEFORE the job is dispatched to it - a machine created and then
 * forgotten because the next line threw is exactly the machine nobody finds. */
export async function setRenderMachine(id: string, machineId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "spl_render_jobs" SET "machine_id" = ${machineId}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id}
  `
}

/** The machines live jobs still have a claim on. Everything else running in the
 * app is fair game for the sweep. */
export async function claimedMachineIds(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ machine_id: string }[]>`
    SELECT "machine_id" FROM "spl_render_jobs"
    WHERE "status" IN ('QUEUED', 'RUNNING') AND "machine_id" <> ''
  `
  return rows.map((row) => row.machine_id)
}

export async function markRenderRunning(id: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "spl_render_jobs"
    SET "status" = 'RUNNING', "started_at" = COALESCE("started_at", CURRENT_TIMESTAMP), "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "status" = 'QUEUED'
  `
}

export async function finishRenderJob(
  id: string,
  result: { mediaId?: string | null; url?: string; error?: string },
): Promise<SplRenderJob | null> {
  const failed = Boolean(result.error)
  const rows = await prisma.$queryRaw<RenderRow[]>`
    UPDATE "spl_render_jobs"
    SET "status" = ${failed ? 'FAILED' : 'DONE'},
        "result_media_id" = ${result.mediaId ?? null},
        "result_url" = ${result.url ?? ''},
        "error" = ${result.error ?? ''},
        "finished_at" = CURRENT_TIMESTAMP,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "status" IN ('QUEUED', 'RUNNING')
    RETURNING *
  `
  return rows[0] ? toRender(rows[0]) : null
}

export async function listRenderJobsForAdmin(limit = 50): Promise<Array<SplRenderJob & { planName: string }>> {
  const rows = await prisma.$queryRaw<Array<RenderRow & { plan_name: string }>>`
    SELECT j.*, p."name" AS plan_name
    FROM "spl_render_jobs" j
    JOIN "spl_plans" p ON p."id" = j."plan_id"
    ORDER BY j."created_at" DESC LIMIT ${limit}
  `
  return rows.map((row) => ({ ...toRender(row), planName: row.plan_name }))
}

/**
 * A job that was picked up and never came back.
 *
 * A worker that dies mid-render leaves a RUNNING row for ever, and "one live job
 * per plan" then means the member can never render that plan again. Ageing them
 * out is what stops one crash becoming a permanent lockout.
 */
export async function failStaleRenderJobs(olderThanMinutes = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000)
  return prisma.$executeRaw`
    UPDATE "spl_render_jobs"
    SET "status" = 'FAILED', "error" = 'The render did not come back in time.', "finished_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
    WHERE "status" IN ('QUEUED', 'RUNNING') AND "created_at" < ${cutoff}
  `
}
