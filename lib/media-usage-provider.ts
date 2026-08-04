import { prisma } from '@/lib/db/prisma'

// Provider for the core.media-usage-providers extension point.
//
// Room and plan thumbnails and finished renders are Media rows this module keeps
// ids for in its own tables. Core has no idea those tables exist, so without this
// every one of them reads as an unused file in the library - and the library's
// "delete everything unused" button would be pointing straight at customers'
// saved plans.
export async function spacePlannerMediaUsageProvider(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ ref: string | null }[]>`
    SELECT "thumbnail_media_id" AS ref FROM "spl_rooms" WHERE "thumbnail_media_id" IS NOT NULL
    UNION ALL
    SELECT "thumbnail_media_id" AS ref FROM "spl_plans" WHERE "thumbnail_media_id" IS NOT NULL
    UNION ALL
    SELECT "result_media_id" AS ref FROM "spl_render_jobs" WHERE "result_media_id" IS NOT NULL
    UNION ALL
    SELECT "result_url" AS ref FROM "spl_render_jobs" WHERE "result_url" <> ''
  `
  return rows.map((row) => row.ref).filter((ref): ref is string => Boolean(ref))
}
