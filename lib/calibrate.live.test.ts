import { describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db/prisma'
import { parseDimensionTriple, parseDimensionValue } from '@/modules/space-planner-for-shop/lib/dimensions'
import { plainUrl } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'

// Calibration: measure the catalogue before trusting anything about it.
//
// Run it:  RUN_SPL_CALIBRATION=1 npx vitest run modules/space-planner-for-shop/lib/calibrate.live.test.ts
//
// It reads and prints; it writes nothing. A live test rather than a script for
// the same reason the module pin check is one - it needs the TypeScript sources
// and the `@/` alias, and vitest already provides both.
//
// Gated, and deliberately not part of `npm test`: it needs a real catalogue on
// the end of DATABASE_URL, and a check that skips where it matters is a false
// pass. The parser itself is covered offline, with no skip, in dimensions.test.ts.
//
// What it reports:
//   1. The real model-file inventory, deduped by QUERY-STRIPPED url - the same
//      file is stored many times over under many stale signatures, so counted raw
//      the pipeline workload looks an order of magnitude bigger than it is.
//   2. A dry run of the dimension parser over every spec value it would ever see,
//      with the junk tail LISTED rather than counted. "1,412 values failed" is not
//      actionable; "Overall Width: please enquire" is a sheet somebody can fix.
//   3. Which categories have no fallback size, since anything in them with no
//      spec sheet draws as a plain block.
//
// What it deliberately does not do is measure the models themselves. That needs
// the asset-signing secret, which lives where the site runs rather than on a dev
// machine, so the measuring pass belongs there. Until it has run, the size ladder
// starts at the spec sheet - which is honest, and visible on the Sizes screen.

const ENABLED = process.env.RUN_SPL_CALIBRATION === '1'

const DIMENSION_ATTRIBUTES = [
  'overall width', 'width', 'overall length',
  'overall depth', 'depth', 'overall projection',
  'overall height (spec)', 'overall height', 'height',
  'height under top', 'width under top',
  'dimensions', 'overall dimensions', 'size',
]

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ present: boolean }[]>(
    `SELECT to_regclass('public.${name}') IS NOT NULL AS present`,
  )
  return Boolean(rows[0]?.present)
}

describe.skipIf(!ENABLED)('space planner calibration', () => {
  it('reports the real model-file inventory', async () => {
    if (!(await tableExists('p3d_models'))) {
      console.log('product-3d-views-for-shop is not installed here.')
      return
    }
    const models = await prisma.$queryRawUnsafe<{ url: string; format: string }[]>(
      `SELECT "url", "format" FROM "p3d_models"`,
    )
    const distinct = new Map<string, string>()
    for (const model of models) distinct.set(plainUrl(model.url), model.format)

    const byFormat: Record<string, number> = {}
    for (const format of distinct.values()) byFormat[format] = (byFormat[format] ?? 0) + 1

    console.log(`rows: ${models.length}`)
    console.log(`distinct files: ${distinct.size} ${JSON.stringify(byFormat)}`)
    console.log(`redundant fetches avoided by stripping the signature: ${models.length - distinct.size}`)

    expect(distinct.size).toBeLessThanOrEqual(models.length)
  })

  it('runs the dimension parser over every value it would ever see', async () => {
    if (!(await tableExists('pat_attribute_values'))) {
      console.log('product-attributes-for-shop is not installed here.')
      return
    }
    const values = await prisma.$queryRawUnsafe<Array<{ attribute: string; label: string; products: number }>>(
      `SELECT a."name" AS attribute, av."label", COUNT(pv."product_id")::int AS products
       FROM "pat_attribute_values" av
       JOIN "pat_attributes" a ON a."id" = av."attribute_id"
       LEFT JOIN "pat_product_values" pv ON pv."value_id" = av."id"
       WHERE lower(a."name") = ANY($1::text[])
       GROUP BY a."name", av."label"
       ORDER BY products DESC`,
      DIMENSION_ATTRIBUTES,
    )

    let read = 0
    let productsCovered = 0
    const junk: typeof values = []
    for (const value of values) {
      const combined = /dimension|size/i.test(value.attribute)
      const ok = combined ? parseDimensionTriple(value.label) !== null : parseDimensionValue(value.label).ok
      if (ok) {
        read += 1
        productsCovered += value.products
      } else {
        junk.push(value)
      }
    }

    const totalProducts = values.reduce((sum, value) => sum + value.products, 0)
    console.log(`distinct values: ${values.length}`)
    console.log(`read: ${read} (${((read / Math.max(1, values.length)) * 100).toFixed(1)}%)`)
    console.log(`products covered: ${productsCovered} of ${totalProducts}`)
    console.log(`junk tail: ${junk.length}`)
    for (const value of junk.slice(0, 30)) {
      console.log(`  ${String(value.products).padStart(6)}  ${value.attribute}: ${JSON.stringify(value.label)}`)
    }

    expect(values.length).toBeGreaterThan(0)
  })

  it('lists the categories with no fallback size', async () => {
    if (!(await tableExists('spl_category_defaults'))) {
      console.log('The planner tables are not installed here yet.')
      return
    }
    const rows = await prisma.$queryRawUnsafe<Array<{ name: string; products: number }>>(
      `SELECT c."name", COUNT(pc."product_id")::int AS products
       FROM "shp_categories" c
       LEFT JOIN "shp_product_categories" pc ON pc."category_id" = c."id"
       LEFT JOIN "spl_category_defaults" d ON d."category_id" = c."id"
       WHERE d."id" IS NULL
       GROUP BY c."name"
       HAVING COUNT(pc."product_id") > 0
       ORDER BY products DESC
       LIMIT 30`,
    )
    console.log(`categories with no fallback size: ${rows.length} (busiest first)`)
    for (const row of rows) console.log(`  ${String(row.products).padStart(6)}  ${row.name}`)
    expect(Array.isArray(rows)).toBe(true)
  })
})
