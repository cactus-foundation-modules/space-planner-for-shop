import { prisma } from '@/lib/db/prisma'

// Provider for the core.media-usage-providers extension point.
//
// Room and plan thumbnails and finished renders are Media rows this module keeps
// ids for in its own tables. Core has no idea those tables exist, so without this
// every one of them reads as an unused file in the library - and the library's
// "delete everything unused" button would be pointing straight at customers'
// saved plans.
//
// The saved plan's own snapshot counts too. It holds the catalogue thumbnail
// each line was showing when the plan was saved, and after the product itself is
// deleted that copy is the only description of it left anywhere - which is
// precisely the picture the unused-media sweep would otherwise take away.
export async function spacePlannerMediaUsageProvider(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ ref: string | null }[]>`
    SELECT "thumbnail_media_id" AS ref FROM "spl_rooms" WHERE "thumbnail_media_id" IS NOT NULL
    UNION ALL
    SELECT "thumbnail_media_id" AS ref FROM "spl_plans" WHERE "thumbnail_media_id" IS NOT NULL
    UNION ALL
    SELECT "result_media_id" AS ref FROM "spl_render_jobs" WHERE "result_media_id" IS NOT NULL
    UNION ALL
    SELECT "result_url" AS ref FROM "spl_render_jobs" WHERE "result_url" <> ''
    UNION ALL
    -- A render job also names the products it was asked to draw, urls and all,
    -- inside its params blob - the one place a picture can be held that none of
    -- the columns above describes. Returned whole as text (the contract allows
    -- it); core matches urls out of the haystack itself.
    SELECT "params"::text AS ref FROM "spl_render_jobs" WHERE "params" IS NOT NULL
    UNION ALL
    SELECT entry.value ->> 'image' AS ref
      FROM "spl_plans", jsonb_each("product_snapshot") AS entry
     WHERE jsonb_typeof("product_snapshot") = 'object' AND entry.value ->> 'image' IS NOT NULL
    UNION ALL
    SELECT entry.value ->> 'image' AS ref
      FROM "spl_plan_versions", jsonb_each("product_snapshot") AS entry
     WHERE jsonb_typeof("product_snapshot") = 'object' AND entry.value ->> 'image' IS NOT NULL
  `
  return rows.map((row) => row.ref).filter((ref): ref is string => Boolean(ref))
}
