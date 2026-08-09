-- Space Planner for Shop - backstops for the two counters that cost money.
--
-- Both of the things this file adds are indexes. No new tables, no new columns,
-- nothing for the backup serialiser to learn.
--
-- Idempotent throughout, like 001 to 003 - the module migration runner sees this
-- file again on later deploys, and a fresh install runs all four in order.

-- One picture at a time, per plan, enforced by the database rather than by a
-- read-then-write in the route.
--
-- The route already looks for a live job before starting another. Two taps of
-- "Make a photo" inside the same second both looked, both found nothing, and
-- both started a machine - and a machine is the one thing in this module with a
-- meter running on it. A partial unique index is the only version of that check
-- which two requests cannot both pass.
--
-- Partial rather than plain: a plan may have any number of FINISHED pictures,
-- and having them is the point.
--
-- Any plan that already carries two live jobs - the very duplicates this index
-- exists to stop - would refuse the index outright, so those are settled first.
-- The newest survives and the rest are marked failed with a sentence the owner
-- can read in the render log. Their machines, if any were ever made, are long
-- since taken down by the idle exit or the nightly sweep.
UPDATE "spl_render_jobs" AS j
   SET "status" = 'FAILED',
       "error" = CASE WHEN "error" = '' THEN 'Overtaken by a newer picture of the same layout.' ELSE "error" END,
       "finished_at" = COALESCE("finished_at", CURRENT_TIMESTAMP),
       "updated_at" = CURRENT_TIMESTAMP
 WHERE j."status" IN ('QUEUED', 'RUNNING')
   AND EXISTS (
       SELECT 1 FROM "spl_render_jobs" AS newer
        WHERE newer."plan_id" = j."plan_id"
          AND newer."status" IN ('QUEUED', 'RUNNING')
          AND (newer."created_at", newer."id") > (j."created_at", j."id")
   );

CREATE UNIQUE INDEX IF NOT EXISTS "spl_render_jobs_one_live_key"
    ON "spl_render_jobs" ("plan_id")
    WHERE "status" IN ('QUEUED', 'RUNNING');

-- Who asked for a picture and when, which is what the rate limit needs to count.
--
-- It used to count spl_events rows instead, matched against the member's current
-- plan ids - so deleting a plan orphaned its events and handed back a fresh
-- allowance. The jobs table carries member_id itself and outlives nothing, so
-- counting here cannot be reset by deleting anything the member is allowed to
-- delete.
CREATE INDEX IF NOT EXISTS "spl_render_jobs_member_created_idx"
    ON "spl_render_jobs" ("member_id", "created_at" DESC);

-- The rate-limit read on the other three member endpoints - the PDF, the plan
-- email and the quote - is "these plan ids, this event name, since this time".
-- Single-column indexes on event and created_at meant a scan of one of the two
-- and a filter for the rest; on a busy shop's event table that is the slowest
-- query in the module, run on the path of every export.
CREATE INDEX IF NOT EXISTS "spl_events_event_plan_created_idx"
    ON "spl_events" ("event", "plan_id", "created_at" DESC);
