import { prisma } from '@/lib/db/prisma'

// Provider for the core.media-usage-providers extension point.
//
// A plan snapshots the catalogue thumbnail of every product on it, a saved
// version keeps its own copy, and a render job holds both the urls it was asked
// to draw and the url of the image it produced. None of it is visible to core,
// so a plan's imagery counted as unused. The JSON columns are returned whole as
// text; core does the matching.
export async function spacePlannerMediaUsageProvider(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ ref: string | null }[]>`
    SELECT "result_url" AS ref FROM "spl_render_jobs" WHERE "result_url" IS NOT NULL
    UNION ALL
    SELECT "params"::text AS ref FROM "spl_render_jobs" WHERE "params" IS NOT NULL
    UNION ALL
    SELECT "product_snapshot"::text AS ref FROM "spl_plans" WHERE "product_snapshot" IS NOT NULL
    UNION ALL
    SELECT "product_snapshot"::text AS ref FROM "spl_plan_versions" WHERE "product_snapshot" IS NOT NULL
  `
  return rows.map((r) => r.ref).filter((r): r is string => !!r)
}
