-- Who did it, so a rate limit cannot be reset by tidying up.
--
-- The PDF, email and quote limits all count events belonging to the member's
-- CURRENT plan ids, because `spl_events` records only the plan. Delete those
-- plans and the events are orphaned, so the count drops to nought and the
-- allowance comes back - which for the PDF route means a fresh run at launching
-- headless browsers inside a serverless function, the most expensive thing a
-- member can ask this module for after a render.
--
-- 004 solved exactly this for renders by counting `spl_render_jobs`, which does
-- carry a member. The other three had nowhere to look. Now they have.
--
-- Nullable, because every row already written has no member to name and a
-- backfill would have to guess. The counters below read the member column, so
-- old rows simply stop being counted - which errs towards letting somebody
-- through rather than refusing them, and empties within one window anyway.

ALTER TABLE "spl_events"
    ADD COLUMN IF NOT EXISTS "member_id" TEXT;

CREATE INDEX IF NOT EXISTS "spl_events_member_window_idx"
    ON "spl_events" ("member_id", "event", "created_at" DESC)
 WHERE "member_id" IS NOT NULL;
