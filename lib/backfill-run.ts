import { advanceBackfill, getBackfill } from '@/modules/space-planner-for-shop/lib/db/jobs'
import { listProductIdsForBackfill } from '@/modules/space-planner-for-shop/lib/db/dimension-cache'
import { resolveDimensions } from '@/modules/space-planner-for-shop/lib/resolve-dimensions'
import type { SplBackfillJob } from '@/modules/space-planner-for-shop/lib/types'

// The dimension rebuild, one bounded step at a time.
//
// Twenty-two thousand active products against a quarter of a million attribute
// rows does not resolve inside the module dispatcher's sixty-second ceiling, and
// this exact mistake is already written down in this codebase: one unbounded
// call over a big grid died at the ceiling before it could advance its phase, and
// every retry started over. So this copies the shape that module arrived at
// rather than rediscovering it:
//
//   - a job row banking a cursor,
//   - a time budget that stops well short of the ceiling,
//   - the caller looping the endpoint,
//   - deterministic ordering so a resume is exact rather than approximate,
//   - a cancel check every chunk, so the stop button stops it in seconds.

/** Well short of the sixty-second ceiling: the last chunk has to finish and the row has to be written. */
export const STEP_TIME_BUDGET_MS = 25_000
export const CHUNK_SIZE = 100

export type StepResult = {
  job: SplBackfillJob | null
  done: boolean
  processed: number
  message: string
}

export async function runBackfillStep(jobId: string): Promise<StepResult> {
  const started = Date.now()
  let job = await getBackfill(jobId)
  if (!job) return { job: null, done: true, processed: 0, message: 'That rebuild no longer exists.' }
  if (job.status === 'CANCELLED') return { job, done: true, processed: 0, message: 'Rebuild stopped.' }
  if (job.status === 'DONE' || job.status === 'FAILED') return { job, done: true, processed: 0, message: 'Rebuild already finished.' }

  let cursor = job.cursor
  let processed = 0
  let resolved = 0
  let failed = 0

  while (Date.now() - started < STEP_TIME_BUDGET_MS) {
    // Re-read the row every chunk rather than every step. This is the cancel
    // check, and checking it once per step would make the stop button take up to
    // half a minute to do anything.
    const live = await getBackfill(jobId)
    if (!live || live.status === 'CANCELLED') {
      return { job: live, done: true, processed, message: 'Rebuild stopped.' }
    }

    const ids = await listProductIdsForBackfill(cursor, CHUNK_SIZE)
    if (ids.length === 0) {
      job = (await advanceBackfill(jobId, { cursor, resolved, skipped: 0, failed, done: true })) ?? live
      return { job, done: true, processed, message: 'Rebuild finished.' }
    }

    try {
      const results = await resolveDimensions(ids, { force: true })
      resolved += results.size
    } catch (error) {
      failed += ids.length
      const message = error instanceof Error ? error.message : 'Unknown error'
      job = (await advanceBackfill(jobId, { cursor, resolved, skipped: 0, failed, done: true, error: message })) ?? live
      return { job, done: true, processed, message: `Rebuild failed: ${message}` }
    }

    cursor += ids.length
    processed += ids.length
  }

  job = (await advanceBackfill(jobId, { cursor, resolved, skipped: 0, failed, done: false })) ?? job
  return { job, done: false, processed, message: 'Still going.' }
}
