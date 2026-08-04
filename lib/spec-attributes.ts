import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

// product-attributes-for-shop is deliberately NOT a hard dependency.
//
// The planner works on a shop that has never installed it - the ladder simply
// drops a rung and leans on category defaults. So the pat_ tables are read
// through raw SQL guarded by a to_regclass probe, and nothing here imports from
// '@/modules/product-attributes-for-shop/...': on an install without the module
// that path does not exist, and a static import would break the build there
// rather than degrade.
//
// Presence is probed against the tables rather than the Module row, because the
// tables are what the queries need and a module row can exist before its
// migration has run.

let cached: { value: boolean; at: number } | null = null
const TTL_MS = 30_000

export async function hasAttributeTables(): Promise<boolean> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value
  const rows = await prisma.$queryRaw<[{ present: boolean }]>`
    SELECT (
      to_regclass('public.pat_attributes') IS NOT NULL
      AND to_regclass('public.pat_attribute_values') IS NOT NULL
      AND to_regclass('public.pat_product_values') IS NOT NULL
    ) AS "present"
  `
  const value = Boolean(rows[0]?.present)
  cached = { value, at: Date.now() }
  return value
}

export function resetAttributeProbeCache(): void {
  cached = null
}

export type SpecValue = { attribute: string; label: string }

/**
 * Every spec value carried by these products, keyed by product id.
 *
 * A variant child carries its own values, which is what makes per-variant sizes
 * work at all - the planner places variants, not listings, so this is read at
 * the same level the cart works at.
 */
export async function getSpecValues(productIds: string[]): Promise<Map<string, SpecValue[]>> {
  const out = new Map<string, SpecValue[]>()
  if (productIds.length === 0) return out
  if (!(await hasAttributeTables())) return out

  const rows = await prisma.$queryRaw<Array<{ product_id: string; attribute: string; label: string }>>`
    SELECT pv."product_id", a."name" AS attribute, av."label"
    FROM "pat_product_values" pv
    JOIN "pat_attribute_values" av ON av."id" = pv."value_id"
    JOIN "pat_attributes" a ON a."id" = av."attribute_id"
    WHERE pv."product_id" IN (${Prisma.join(productIds)})
  `
  for (const row of rows) {
    const list = out.get(row.product_id) ?? []
    list.push({ attribute: row.attribute, label: row.label })
    out.set(row.product_id, list)
  }
  return out
}

/**
 * Every distinct value of one named attribute across the catalogue.
 *
 * The calibration pass runs the draft parser over this so the junk tail is
 * measured against the real data before any of it is trusted, rather than
 * discovered by a customer whose desk came out four metres wide.
 */
export async function listAllValuesForAttributes(names: string[]): Promise<Array<{ attribute: string; label: string; products: number }>> {
  if (names.length === 0) return []
  if (!(await hasAttributeTables())) return []
  const lowered = names.map((n) => n.toLowerCase())
  const rows = await prisma.$queryRaw<Array<{ attribute: string; label: string; products: bigint }>>`
    SELECT a."name" AS attribute, av."label", COUNT(pv."product_id")::bigint AS products
    FROM "pat_attribute_values" av
    JOIN "pat_attributes" a ON a."id" = av."attribute_id"
    LEFT JOIN "pat_product_values" pv ON pv."value_id" = av."id"
    WHERE lower(a."name") IN (${Prisma.join(lowered)})
    GROUP BY a."name", av."label"
    ORDER BY products DESC
  `
  return rows.map((row) => ({ attribute: row.attribute, label: row.label, products: Number(row.products) }))
}

/**
 * "Made to order" has no flag on shp_products - it lives in the spec attributes,
 * which is worth stating plainly because everybody looks for the column first.
 */
export function isMadeToOrder(values: SpecValue[]): boolean {
  return values.some((v) => /made\s*to\s*order/i.test(v.label) || /made\s*to\s*order/i.test(v.attribute))
}
