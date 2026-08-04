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

export async function createRenderJob(input: {
  planId: string
  memberId: string | null
  params: Record<string, unknown>
  planUpdatedAt: Date
}): Promise<SplRenderJob> {
  const token = randomBytes(24).toString('base64url')
  const rows = await prisma.$queryRaw<RenderRow[]>`
    INSERT INTO "spl_render_jobs" ("plan_id", "member_id", "params", "plan_updated_at", "callback_token")
    VALUES (${input.planId}, ${input.memberId}, ${JSON.stringify(input.params)}::jsonb, ${input.planUpdatedAt}, ${token})
    RETURNING *
  `
  const row = rows[0]
  if (!row) throw new Error('Could not queue that picture.')
  return toRender(row)
}

/** The per-job secret the worker echoes back, so a finished-job POST cannot be forged. */
export async function getRenderCallbackToken(id: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ callback_token: string }[]>`
    SELECT "callback_token" FROM "spl_render_jobs" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0]?.callback_token ?? null
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
