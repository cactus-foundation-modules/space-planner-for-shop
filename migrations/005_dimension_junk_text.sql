-- A home for the text the size parser could NOT read.
--
-- `parsed_from` was doing two jobs and could only ever do one of them at a
-- time: it holds the text that parsed successfully whenever any axis parsed,
-- and the text that failed only when nothing parsed at all. The Sizes screen's
-- "Measurements we could not read" card selects rows with a non-empty
-- `parsed_from` that fell back to a category default or the generic block -
-- which is precisely the shape of a product that parsed PARTIALLY, and so is
-- the one product it should never list.
--
-- On Deskwell that made the card 100% false positives: 505 rows matched, all
-- 505 had measurements that had parsed, and their text read like
-- "Overall Width: 120cm | Overall Height (spec): 180cm" - perfectly good sheet
-- entries, listed under a heading telling the owner to go and fix them. The
-- genuine cases were all excluded, because a product with nothing readable at
-- all usually has no dimension attributes to quote either.
--
-- So the junk gets a column of its own. It was already being computed and
-- thrown away on every partial parse.

ALTER TABLE "spl_dimension_cache"
    ADD COLUMN IF NOT EXISTS "junk_text" text NOT NULL DEFAULT '';

-- Rows written before this column existed carry the parser's failure in
-- `parsed_from` when - and only when - they read nothing at all. That is the
-- one case the two columns agree on, so it can be moved across rather than
-- waiting for the next rebuild to work it out again.
UPDATE "spl_dimension_cache"
   SET "junk_text" = "parsed_from"
 WHERE "junk_text" = ''
   AND "parsed_from" <> ''
   AND "source" = 'marker'
   AND "width_mm" IS NULL
   AND "depth_mm" IS NULL
   AND "height_mm" IS NULL;

CREATE INDEX IF NOT EXISTS "spl_dimension_cache_junk_idx"
    ON "spl_dimension_cache" ("resolved_at" DESC)
 WHERE "junk_text" <> '';
