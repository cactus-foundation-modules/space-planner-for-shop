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
  junk_text: string
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
    junkText: row.junk_text ?? '',
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
      "product_id", "width_mm", "depth_mm", "height_mm", "source", "parsed_from", "junk_text",
      "conflict", "conflict_note", "mount_type", "product_updated_at", "stale", "resolved_at"
    ) VALUES (
      ${entry.productId}, ${entry.widthMm}, ${entry.depthMm}, ${entry.heightMm}, ${entry.source}, ${entry.parsedFrom}, ${entry.junkText},
      ${entry.conflict}, ${entry.conflictNote}, ${entry.mountType}, ${entry.productUpdatedAt}, false, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("product_id") DO UPDATE SET
      "width_mm" = EXCLUDED."width_mm",
      "depth_mm" = EXCLUDED."depth_mm",
      "height_mm" = EXCLUDED."height_mm",
      "source" = EXCLUDED."source",
      "parsed_from" = EXCLUDED."parsed_from",
      "junk_text" = EXCLUDED."junk_text",
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
          ${entry.productId}, ${entry.widthMm}, ${entry.depthMm}, ${entry.heightMm}, ${entry.source}, ${entry.parsedFrom}, ${entry.junkText},
          ${entry.conflict}, ${entry.conflictNote}, ${entry.mountType}, ${entry.productUpdatedAt}, false, CURRENT_TIMESTAMP
        )`,
      ),
    )
    await prisma.$executeRaw`
      INSERT INTO "spl_dimension_cache" (
        "product_id", "width_mm", "depth_mm", "height_mm", "source", "parsed_from", "junk_text",
        "conflict", "conflict_note", "mount_type", "product_updated_at", "stale", "resolved_at"
      ) VALUES ${values}
      ON CONFLICT ("product_id") DO UPDATE SET
        "width_mm" = EXCLUDED."width_mm",
        "depth_mm" = EXCLUDED."depth_mm",
        "height_mm" = EXCLUDED."height_mm",
        "source" = EXCLUDED."source",
        "parsed_from" = EXCLUDED."parsed_from",
      "junk_text" = EXCLUDED."junk_text",
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

/**
 * Categories with no fallback size yet, worst first.
 *
 * "Worst" is measured in products currently leaning on the gap: anything ACTIVE
 * whose size would come from this category, and which has no better answer than
 * a category default. The count is what lets ten minutes of typing go where it
 * is actually felt, so it has to describe the same products the typing would
 * reach - and that means counting a product exactly where resolveDimensions
 * would look for it, not everywhere it is filed.
 *
 * Two rules matter, and both were wrong when this counted raw category rows.
 * A product in four categories is sized from ONE of them - the lowest id, which
 * is what getPrimaryCategoryForProducts picks - so counting it under all four
 * advertised work that would change nothing in the other three. And a variation
 * child has no category row of its own; it inherits its listing's. Leaving the
 * children out hid the categories where the typing pays best, which on a
 * catalogue of ranges is most of them.
 */
export async function listCategoriesWithoutDefaults(limit = 50): Promise<Array<{ categoryId: string; name: string; affected: number }>> {
  // svr_variants belongs to shop-variations. It is a hard dependency of this
  // module, but a module can be installed with its migrations not yet run, and
  // a missing table would take the whole size report down with it.
  const [{ present: hasVariants }] = await prisma.$queryRaw<[{ present: boolean }]>`
    SELECT (to_regclass('public.svr_variants') IS NOT NULL) AS "present"
  `
  const childrenOfListings = hasVariants
    ? Prisma.sql`LEFT JOIN "svr_variants" v ON v."child_product_id" = p."id"
        LEFT JOIN primary_category parent ON parent."product_id" = v."product_id"`
    : Prisma.sql`LEFT JOIN primary_category parent ON FALSE`

  const rows = await prisma.$queryRaw<Array<{ category_id: string; name: string; affected: bigint }>>`
    WITH primary_category AS (
      -- One row per product: the category resolveDimensions would consult.
      SELECT DISTINCT ON (pc."product_id") pc."product_id", pc."category_id"
        FROM "shp_product_categories" pc
       ORDER BY pc."product_id", pc."category_id"
    ),
    sized_from AS (
      -- Every ACTIVE product, against the category its size would come from:
      -- its own where it has one, otherwise its listing's.
      SELECT p."id" AS product_id,
             COALESCE(own."category_id", parent."category_id") AS category_id
        FROM "shp_products" p
        LEFT JOIN primary_category own ON own."product_id" = p."id"
        ${childrenOfListings}
       WHERE p."status" = 'ACTIVE'
    )
    SELECT cat."id" AS category_id, cat."name",
           COALESCE((
             SELECT COUNT(*) FROM sized_from s
             LEFT JOIN "spl_dimension_cache" c ON c."product_id" = s."product_id"
             WHERE s."category_id" = cat."id"
               AND (c."product_id" IS NULL OR c."source" IN ('category_default', 'marker'))
           ), 0)::bigint AS affected
    FROM "shp_categories" cat
    LEFT JOIN "spl_category_defaults" d ON d."category_id" = cat."id"
    WHERE d."id" IS NULL
    ORDER BY affected DESC, cat."name" ASC
    LIMIT ${limit}
  `
  return rows.map((row) => ({ categoryId: row.category_id, name: row.name, affected: Number(row.affected) }))
}

/**
 * The junk tail: what the parser choked on, with the actual text so it can be
 * fixed.
 *
 * Selected on `junk_text`, which exists precisely because the old test - a
 * non-empty `parsed_from` on a row that fell back - selects a product that
 * parsed PARTIALLY and excludes one that parsed nothing. On Deskwell that was
 * 505 rows, every one of them a false positive, under a heading telling the
 * owner to go and correct sheet entries that were already right.
 */
export async function listJunkTail(limit = 100): Promise<Array<{ productId: string; name: string; parsedFrom: string; source: string }>> {
  const rows = await prisma.$queryRaw<Array<{ product_id: string; name: string; parsed_from: string; source: string }>>`
    SELECT c."product_id", p."name", c."junk_text" AS "parsed_from", c."source"
    FROM "spl_dimension_cache" c
    JOIN "shp_products" p ON p."id" = c."product_id"
    WHERE c."junk_text" <> ''
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

/**
 * Mark everything sized from a category as needing working out again.
 *
 * Without this, typing a category fallback changed nothing anybody could see.
 * The freshness test compares the cache row against `shp_products.updated_at`,
 * and setting a category default does not touch a product - so the nightly
 * sweep never picked those products up, the plan-load refresh never picked them
 * up, and `resolveDimensions` short-circuited on `fresh` and handed back the old
 * generic block. The owner filled in a size for 412 products and every one of
 * them carried on being drawn as an 800 by 600 by 750 box.
 *
 * `stale` is the column that exists for exactly this and had no writer. Only
 * rows that are actually leaning on a fallback are touched: a product measured
 * from its own model or spec sheet is not affected by a category default and
 * has no reason to be resolved again.
 */
async function markCategoryDimensionsStale(categoryId: string): Promise<void> {
  // The variations of a listing inherit its category, so they have to be marked
  // too. svr_variants belongs to shop-variations, which is a hard dependency but
  // may not have run its migrations yet - and a missing table here would fail
  // the owner's save rather than just skipping the children.
  const [{ present: hasVariants }] = await prisma.$queryRaw<[{ present: boolean }]>`
    SELECT (to_regclass('public.svr_variants') IS NOT NULL) AS "present"
  `
  const children = hasVariants
    ? Prisma.sql`
        UNION
        SELECT v."child_product_id"
          FROM "shp_product_categories" pc
          JOIN "svr_variants" v ON v."product_id" = pc."product_id"
         WHERE pc."category_id" = ${categoryId}`
    : Prisma.empty

  await prisma.$executeRaw`
    UPDATE "spl_dimension_cache"
    SET "stale" = true
    WHERE "source" IN ('category_default', 'marker')
      AND "product_id" IN (
        SELECT pc."product_id" FROM "shp_product_categories" pc WHERE pc."category_id" = ${categoryId}
        ${children}
      )
  `
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
  await markCategoryDimensionsStale(input.categoryId)
}

export async function deleteCategoryDefault(categoryId: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "spl_category_defaults" WHERE "category_id" = ${categoryId}`
  await markCategoryDimensionsStale(categoryId)
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
