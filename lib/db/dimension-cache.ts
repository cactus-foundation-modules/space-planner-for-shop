import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { MountType, SizeSource, SplCategoryDefault, SplDimensions } from '@/modules/space-planner-for-shop/lib/types'

// The materialised output of the resolution ladder, and the per-category
// fallbacks that fill its gaps.
//
// The planner never parses attribute text at request time: it reads this table.
// Freshness is three-layered, because catalogue edits arrive by Google Sheet
// pull and fire no product-save event, so there is no event to hang on:
//   (a) plan load spot-checks the products it actually references,
//   (b) the nightly cron sweeps a bounded slice of the stale tail,
//   (c) the owner can rebuild the lot from the admin, watching a progress bar.

type CacheRow = {
  product_id: string
  width_mm: number | null
  depth_mm: number | null
  height_mm: number | null
  source: string
  parsed_from: string
  conflict: boolean
  conflict_note: string
  mount_type: string
  product_updated_at: Date | null
  stale: boolean
  resolved_at: Date
}

function toDimensions(row: CacheRow): SplDimensions {
  return {
    productId: row.product_id,
    widthMm: row.width_mm,
    depthMm: row.depth_mm,
    heightMm: row.height_mm,
    source: row.source as SizeSource,
    parsedFrom: row.parsed_from,
    conflict: row.conflict,
    conflictNote: row.conflict_note,
    mountType: row.mount_type as MountType,
    productUpdatedAt: row.product_updated_at,
    stale: row.stale,
    resolvedAt: row.resolved_at,
  }
}

export async function getDimensionsForProducts(productIds: string[]): Promise<Map<string, SplDimensions>> {
  if (productIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<CacheRow[]>`
    SELECT * FROM "spl_dimension_cache" WHERE "product_id" IN (${Prisma.join(productIds)})
  `
  return new Map(rows.map((row) => [row.product_id, toDimensions(row)]))
}

export async function saveDimensions(entry: SplDimensions): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "spl_dimension_cache" (
      "product_id", "width_mm", "depth_mm", "height_mm", "source", "parsed_from",
      "conflict", "conflict_note", "mount_type", "product_updated_at", "stale", "resolved_at"
    ) VALUES (
      ${entry.productId}, ${entry.widthMm}, ${entry.depthMm}, ${entry.heightMm}, ${entry.source}, ${entry.parsedFrom},
      ${entry.conflict}, ${entry.conflictNote}, ${entry.mountType}, ${entry.productUpdatedAt}, false, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("product_id") DO UPDATE SET
      "width_mm" = EXCLUDED."width_mm",
      "depth_mm" = EXCLUDED."depth_mm",
      "height_mm" = EXCLUDED."height_mm",
      "source" = EXCLUDED."source",
      "parsed_from" = EXCLUDED."parsed_from",
      "conflict" = EXCLUDED."conflict",
      "conflict_note" = EXCLUDED."conflict_note",
      "mount_type" = EXCLUDED."mount_type",
      "product_updated_at" = EXCLUDED."product_updated_at",
      "stale" = false,
      "resolved_at" = CURRENT_TIMESTAMP
  `
}

/**
 * The same write, for a set.
 *
 * One statement rather than one per product, because the callers are the ones
 * that hurt: a browse page resolves 24, a plan load resolves everything in the
 * room, and the nightly sweep resolves up to five hundred. Against a pooled
 * connection each of those was a separate round trip - four of them, on
 * PgBouncer - for a row of six integers.
 *
 * Chunked, because a parameterised statement has a ceiling on how many
 * placeholders it may carry and eleven per row reaches it sooner than anybody
 * expects.
 */
export async function saveDimensionsMany(entries: SplDimensions[]): Promise<void> {
  const CHUNK = 200
  for (let start = 0; start < entries.length; start += CHUNK) {
    const chunk = entries.slice(start, start + CHUNK)
    if (chunk.length === 0) continue
    const values = Prisma.join(
      chunk.map(
        (entry) => Prisma.sql`(
          ${entry.productId}, ${entry.widthMm}, ${entry.depthMm}, ${entry.heightMm}, ${entry.source}, ${entry.parsedFrom},
          ${entry.conflict}, ${entry.conflictNote}, ${entry.mountType}, ${entry.productUpdatedAt}, false, CURRENT_TIMESTAMP
        )`,
      ),
    )
    await prisma.$executeRaw`
      INSERT INTO "spl_dimension_cache" (
        "product_id", "width_mm", "depth_mm", "height_mm", "source", "parsed_from",
        "conflict", "conflict_note", "mount_type", "product_updated_at", "stale", "resolved_at"
      ) VALUES ${values}
      ON CONFLICT ("product_id") DO UPDATE SET
        "width_mm" = EXCLUDED."width_mm",
        "depth_mm" = EXCLUDED."depth_mm",
        "height_mm" = EXCLUDED."height_mm",
        "source" = EXCLUDED."source",
        "parsed_from" = EXCLUDED."parsed_from",
        "conflict" = EXCLUDED."conflict",
        "conflict_note" = EXCLUDED."conflict_note",
        "mount_type" = EXCLUDED."mount_type",
        "product_updated_at" = EXCLUDED."product_updated_at",
        "stale" = false,
        "resolved_at" = CURRENT_TIMESTAMP
    `
  }
}

/**
 * Which of these products have moved on since we last measured them.
 *
 * One query, comparing the product's own stamp with the one banked at resolution
 * time. Cheap enough to run on every plan load for the handful of products a
 * plan actually references, which is layer (a) of the freshness story.
 */
export async function findStaleProducts(productIds: string[]): Promise<string[]> {
  if (productIds.length === 0) return []
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p."id"
    FROM "shp_products" p
    LEFT JOIN "spl_dimension_cache" c ON c."product_id" = p."id"
    WHERE p."id" IN (${Prisma.join(productIds)})
      AND (c."product_id" IS NULL OR c."stale" = true OR c."product_updated_at" IS DISTINCT FROM p."updated_at")
  `
  return rows.map((row) => row.id)
}

/** The bounded slice the nightly cron re-resolves. Deterministic order, oldest first. */
export async function listStaleProductIds(limit: number): Promise<string[]> {
  if (limit <= 0) return []
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p."id"
    FROM "shp_products" p
    LEFT JOIN "spl_dimension_cache" c ON c."product_id" = p."id"
    WHERE p."status" = 'ACTIVE'
      AND (c."product_id" IS NULL OR c."stale" = true OR c."product_updated_at" IS DISTINCT FROM p."updated_at")
    ORDER BY c."resolved_at" ASC NULLS FIRST, p."id" ASC
    LIMIT ${limit}
  `
  return rows.map((row) => row.id)
}

/**
 * A deterministically-ordered page of active products, for the resumable
 * rebuild. Ordered by id so a resume lands exactly where it stopped rather than
 * approximately - an ordering that can shift under the cursor is how a backfill
 * silently skips rows.
 */
export async function listProductIdsForBackfill(offset: number, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "shp_products" WHERE "status" = 'ACTIVE'
    ORDER BY "id" ASC LIMIT ${limit} OFFSET ${offset}
  `
  return rows.map((row) => row.id)
}

export async function countActiveProducts(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "shp_products" WHERE "status" = 'ACTIVE'
  `
  return Number(rows[0]?.count ?? 0)
}

/**
 * Cached sizes for products the shop no longer has.
 *
 * `product_id` deliberately carries no foreign key - shp_products belongs to the
 * shop module and this schema keeps its one foreign key between two of its own
 * tables - so a deleted product leaves its cache row behind rather than
 * cascading it away. Nothing reads a stranded row, but the dimension report
 * counts rows rather than products, so they quietly inflate every figure the
 * owner is shown. Same shape and same reason as the orphaned-room sweep.
 *
 * Only ever deletes cache. A row here is the materialised output of the
 * resolution ladder and rebuilds itself the moment its product comes back.
 */
export async function deleteOrphanedDimensions(): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "spl_dimension_cache" c
    WHERE NOT EXISTS (SELECT 1 FROM "shp_products" p WHERE p."id" = c."product_id")
  `
}

export type DimensionReport = {
  total: number
  bySource: Record<string, number>
  conflicts: number
  missing: number
  categoriesWithoutDefaults: number
}

export async function getDimensionReport(): Promise<DimensionReport> {
  const [sourceRows, conflictRows, missingRows, categoryRows] = await Promise.all([
    prisma.$queryRaw<{ source: string; count: bigint }[]>`
      SELECT "source", COUNT(*)::bigint AS count FROM "spl_dimension_cache" GROUP BY "source"
    `,
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "spl_dimension_cache" WHERE "conflict" = true
    `,
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "shp_products" p
      LEFT JOIN "spl_dimension_cache" c ON c."product_id" = p."id"
      WHERE p."status" = 'ACTIVE' AND c."product_id" IS NULL
    `,
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "shp_categories" cat
      LEFT JOIN "spl_category_defaults" d ON d."category_id" = cat."id"
      WHERE d."id" IS NULL
    `,
  ])

  const bySource: Record<string, number> = {}
  let total = 0
  for (const row of sourceRows) {
    bySource[row.source] = Number(row.count)
    total += Number(row.count)
  }

  return {
    total,
    bySource,
    conflicts: Number(conflictRows[0]?.count ?? 0),
    missing: Number(missingRows[0]?.count ?? 0),
    categoriesWithoutDefaults: Number(categoryRows[0]?.count ?? 0),
  }
}

/** The junk tail: what the parser choked on, with the actual text so it can be fixed. */
export async function listJunkTail(limit = 100): Promise<Array<{ productId: string; name: string; parsedFrom: string; source: string }>> {
  const rows = await prisma.$queryRaw<Array<{ product_id: string; name: string; parsed_from: string; source: string }>>`
    SELECT c."product_id", p."name", c."parsed_from", c."source"
    FROM "spl_dimension_cache" c
    JOIN "shp_products" p ON p."id" = c."product_id"
    WHERE c."source" IN ('category_default', 'marker') AND c."parsed_from" <> ''
    ORDER BY c."resolved_at" DESC
    LIMIT ${limit}
  `
  return rows.map((row) => ({ productId: row.product_id, name: row.name, parsedFrom: row.parsed_from, source: row.source }))
}

export async function listConflicts(limit = 100): Promise<Array<{ productId: string; name: string; note: string }>> {
  const rows = await prisma.$queryRaw<Array<{ product_id: string; name: string; conflict_note: string }>>`
    SELECT c."product_id", p."name", c."conflict_note"
    FROM "spl_dimension_cache" c
    JOIN "shp_products" p ON p."id" = c."product_id"
    WHERE c."conflict" = true
    ORDER BY p."name" ASC
    LIMIT ${limit}
  `
  return rows.map((row) => ({ productId: row.product_id, name: row.name, note: row.conflict_note }))
}

// ---------------------------------------------------------------------------
// Category defaults
// ---------------------------------------------------------------------------

type DefaultRow = {
  id: string
  category_id: string
  width_mm: number | null
  depth_mm: number | null
  height_mm: number | null
  mount_type: string
}

function toDefault(row: DefaultRow): SplCategoryDefault {
  return {
    id: row.id,
    categoryId: row.category_id,
    widthMm: row.width_mm,
    depthMm: row.depth_mm,
    heightMm: row.height_mm,
    mountType: row.mount_type as MountType,
  }
}

export async function listCategoryDefaults(): Promise<Array<SplCategoryDefault & { categoryName: string }>> {
  const rows = await prisma.$queryRaw<Array<DefaultRow & { category_name: string }>>`
    SELECT d.*, c."name" AS category_name
    FROM "spl_category_defaults" d
    JOIN "shp_categories" c ON c."id" = d."category_id"
    ORDER BY c."name" ASC
  `
  return rows.map((row) => ({ ...toDefault(row), categoryName: row.category_name }))
}

export async function getCategoryDefaultsMap(): Promise<Map<string, SplCategoryDefault>> {
  const rows = await prisma.$queryRaw<DefaultRow[]>`SELECT * FROM "spl_category_defaults"`
  return new Map(rows.map((row) => [row.category_id, toDefault(row)]))
}

export async function upsertCategoryDefault(input: {
  categoryId: string
  widthMm: number | null
  depthMm: number | null
  heightMm: number | null
  mountType: MountType
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "spl_category_defaults" ("category_id", "width_mm", "depth_mm", "height_mm", "mount_type")
    VALUES (${input.categoryId}, ${input.widthMm}, ${input.depthMm}, ${input.heightMm}, ${input.mountType})
    ON CONFLICT ("category_id") DO UPDATE SET
      "width_mm" = EXCLUDED."width_mm",
      "depth_mm" = EXCLUDED."depth_mm",
      "height_mm" = EXCLUDED."height_mm",
      "mount_type" = EXCLUDED."mount_type",
      "updated_at" = CURRENT_TIMESTAMP
  `
}

export async function deleteCategoryDefault(categoryId: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "spl_category_defaults" WHERE "category_id" = ${categoryId}`
}

/** Which category each of these products is filed under first. */
export async function getPrimaryCategoryForProducts(productIds: string[]): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<{ product_id: string; category_id: string }[]>`
    SELECT DISTINCT ON (pc."product_id") pc."product_id", pc."category_id"
    FROM "shp_product_categories" pc
    WHERE pc."product_id" IN (${Prisma.join(productIds)})
    ORDER BY pc."product_id", pc."category_id"
  `
  return new Map(rows.map((row) => [row.product_id, row.category_id]))
}
