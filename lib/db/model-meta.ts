import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { MountType, SplModelMeta } from '@/modules/space-planner-for-shop/lib/types'

// The curated fix-up layer. Two scopes with a stated precedence, because they
// answer different questions:
//
//   file-level (keyed by p3d_models.id) - which way this GLB faces, what its
//     footprint really is, whether it survives decimation. Properties of the
//     file, shared by every variant that uses it.
//   product-level (keyed by shp_products.id) - how this thing mounts, and notes.
//     Properties of the product, true regardless of which file draws it.
//
// Where both speak to the same thing, product-level wins: it is the more
// specific statement. Nothing here is required - an empty table means the
// planner uses what it measured, which is right often enough that curation is a
// ten-minute upkeep job rather than a prerequisite.

type MetaRow = {
  id: string
  scope: string
  model_id: string | null
  product_id: string | null
  yaw_offset_degrees: number
  footprint_override: unknown
  no_decimation: boolean
  mount_type: string | null
  notes: string
  reviewed_at: Date | null
}

/** `IN (...)` over a caller-supplied list, parameterised rather than interpolated. */
function prismaJoin(values: string[]): Prisma.Sql {
  return Prisma.join(values)
}

function toMeta(row: MetaRow): SplModelMeta {
  const footprint = row.footprint_override as { widthMm?: number; depthMm?: number } | null
  return {
    id: row.id,
    scope: row.scope === 'product' ? 'product' : 'file',
    modelId: row.model_id,
    productId: row.product_id,
    yawOffsetDegrees: row.yaw_offset_degrees,
    footprintOverride:
      footprint && typeof footprint.widthMm === 'number' && typeof footprint.depthMm === 'number'
        ? { widthMm: footprint.widthMm, depthMm: footprint.depthMm }
        : null,
    noDecimation: row.no_decimation,
    mountType: (row.mount_type as MountType | null) ?? null,
    notes: row.notes,
    reviewedAt: row.reviewed_at,
  }
}

export async function getModelMetaForModels(modelIds: string[]): Promise<Map<string, SplModelMeta>> {
  if (modelIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<MetaRow[]>`
    SELECT * FROM "spl_model_meta" WHERE "scope" = 'file' AND "model_id" IN (${prismaJoin(modelIds)})
  `
  return new Map(rows.map((row) => [row.model_id as string, toMeta(row)]))
}

export async function getModelMetaForProducts(productIds: string[]): Promise<Map<string, SplModelMeta>> {
  if (productIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<MetaRow[]>`
    SELECT * FROM "spl_model_meta" WHERE "scope" = 'product' AND "product_id" IN (${prismaJoin(productIds)})
  `
  return new Map(rows.map((row) => [row.product_id as string, toMeta(row)]))
}

/**
 * A PATCH, in the sense the word is normally used: a field the caller did not
 * mention keeps whatever it had.
 *
 * Worth stating because it did not, and the admin screen sends exactly one field
 * at a time. Setting a model's yaw offset therefore cleared the tick saying
 * somebody had checked it, and marking it checked cleared the footprint
 * override - each save quietly undoing the last.
 *
 * `footprintOverride` distinguishes absent from null on purpose: absent keeps
 * the override, an explicit null removes it.
 */
export async function upsertFileMeta(
  modelId: string,
  patch: { yawOffsetDegrees?: number; footprintOverride?: { widthMm: number; depthMm: number } | null; noDecimation?: boolean; notes?: string; reviewed?: boolean },
): Promise<void> {
  const footprint = patch.footprintOverride === undefined
    ? undefined
    : patch.footprintOverride === null
      ? null
      : JSON.stringify(patch.footprintOverride)
  const reviewedAt = patch.reviewed === undefined ? undefined : patch.reviewed ? new Date() : null

  await prisma.$executeRaw`
    INSERT INTO "spl_model_meta" ("scope", "model_id", "yaw_offset_degrees", "footprint_override", "no_decimation", "notes", "reviewed_at")
    VALUES (
      'file',
      ${modelId},
      ${patch.yawOffsetDegrees ?? 0},
      ${footprint ?? null}::jsonb,
      ${patch.noDecimation ?? false},
      ${patch.notes ?? ''},
      ${reviewedAt ?? null}
    )
    -- The predicate is not decoration. Both unique indexes on this table are
    -- PARTIAL (001_initial: WHERE "model_id" IS NOT NULL, because a product-scope
    -- row leaves it null), and Postgres will not infer a partial index as the
    -- arbiter unless the statement repeats its predicate - it raises 42P10 at
    -- plan time instead. Without it every yaw correction, every "leave the
    -- detail alone" tick and every "mark as checked" failed, and the screen told
    -- the owner to check their connection.
    ON CONFLICT ("model_id") WHERE "model_id" IS NOT NULL DO UPDATE SET
      "yaw_offset_degrees" = COALESCE(${patch.yawOffsetDegrees ?? null}, "spl_model_meta"."yaw_offset_degrees"),
      "footprint_override" = CASE
        WHEN ${patch.footprintOverride === undefined} THEN "spl_model_meta"."footprint_override"
        ELSE ${footprint ?? null}::jsonb
      END,
      "no_decimation" = COALESCE(${patch.noDecimation ?? null}, "spl_model_meta"."no_decimation"),
      "notes" = COALESCE(${patch.notes ?? null}, "spl_model_meta"."notes"),
      "reviewed_at" = CASE
        WHEN ${patch.reviewed === undefined} THEN "spl_model_meta"."reviewed_at"
        ELSE ${reviewedAt ?? null}
      END,
      "updated_at" = CURRENT_TIMESTAMP
  `
}

/** As upsertFileMeta: an unmentioned field keeps what it had. */
export async function upsertProductMeta(
  productId: string,
  patch: { mountType?: MountType | null; notes?: string; reviewed?: boolean },
): Promise<void> {
  const reviewedAt = patch.reviewed === undefined ? undefined : patch.reviewed ? new Date() : null

  await prisma.$executeRaw`
    INSERT INTO "spl_model_meta" ("scope", "product_id", "mount_type", "notes", "reviewed_at")
    VALUES ('product', ${productId}, ${patch.mountType ?? null}, ${patch.notes ?? ''}, ${reviewedAt ?? null})
    -- Partial index again, same reason as upsertFileMeta above.
    ON CONFLICT ("product_id") WHERE "product_id" IS NOT NULL DO UPDATE SET
      "mount_type" = CASE
        WHEN ${patch.mountType === undefined} THEN "spl_model_meta"."mount_type"
        ELSE ${patch.mountType ?? null}
      END,
      "notes" = COALESCE(${patch.notes ?? null}, "spl_model_meta"."notes"),
      "reviewed_at" = CASE
        WHEN ${patch.reviewed === undefined} THEN "spl_model_meta"."reviewed_at"
        ELSE ${reviewedAt ?? null}
      END,
      "updated_at" = CURRENT_TIMESTAMP
  `
}

/**
 * Every product the planner could draw a real model for.
 *
 * Both levels, because the planner works at both: it browses at listing level
 * and places at variant level, so a listing whose variations carry the model
 * needs a measured size of its own just as much as they do.
 *
 * Ordered by name so the measuring pass is watchable and a resume is exact.
 */
export async function listModelledProductIds(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT p."id", p."name"
    FROM "shp_products" p
    WHERE p."status" = 'ACTIVE'
      AND (
        EXISTS (SELECT 1 FROM "p3d_models" m WHERE m."product_id" = p."id")
        OR EXISTS (
          SELECT 1 FROM "svr_variants" v
          JOIN "p3d_models" m ON m."product_id" = v."child_product_id"
          WHERE v."product_id" = p."id"
        )
      )
    ORDER BY p."name" ASC
  `
  return rows.map((row) => row.id)
}

/**
 * The worst-offenders view the admin sorts on: modelled products nobody has
 * looked at yet, most-placed first. Upkeep is worth ten minutes when it is
 * pointed at the twelve models customers actually use, and worth nothing at all
 * when it is a list of two hundred and fifty in alphabetical order.
 */
export async function listUnreviewedModels(
  limit = 50,
  opts: { includeReviewed?: boolean } = {},
): Promise<Array<{ modelId: string; productId: string; productName: string; url: string; format: string; placements: number; yawOffsetDegrees: number; noDecimation: boolean; reviewed: boolean }>> {
  // The current corrections ride along so the screen can SHOW them: a form that
  // renders every yaw as 0° whatever is stored is a form that tells the person
  // correcting models that their last correction did not take.
  //
  // The product's name rides along too. The screen used to show the file name
  // alone, and a person correcting "chair_v3_final_FINAL.glb" has no idea which
  // of forty chairs they are about to turn round.
  //
  // includeReviewed drops the worst-offenders filter. This is the only listing
  // there is, so without it marking a model checked removed the one screen that
  // can correct it - and a rotation noticed as wrong a week later had nowhere
  // left to be put right.
  const unchecked = opts.includeReviewed
    ? Prisma.sql`TRUE`
    : Prisma.sql`(meta."id" IS NULL OR meta."reviewed_at" IS NULL)`
  const rows = await prisma.$queryRaw<Array<{ model_id: string; product_id: string; product_name: string | null; url: string; format: string; placements: bigint; yaw_offset_degrees: number | null; no_decimation: boolean | null; reviewed_at: Date | null }>>`
    SELECT m."id" AS model_id, m."product_id", p."name" AS product_name, m."url", m."format",
           COALESCE((SELECT COUNT(*) FROM "spl_events" e WHERE e."product_id" = m."product_id" AND e."event" = 'item.placed'), 0)::bigint AS placements,
           meta."yaw_offset_degrees", meta."no_decimation", meta."reviewed_at"
    FROM "p3d_models" m
    LEFT JOIN "shp_products" p ON p."id" = m."product_id"
    LEFT JOIN "spl_model_meta" meta ON meta."model_id" = m."id"
    WHERE ${unchecked}
    ORDER BY placements DESC, m."created_at" DESC
    LIMIT ${limit}
  `
  return rows.map((row) => ({
    modelId: row.model_id,
    productId: row.product_id,
    productName: row.product_name ?? '',
    url: row.url,
    format: row.format,
    placements: Number(row.placements),
    yawOffsetDegrees: row.yaw_offset_degrees ?? 0,
    noDecimation: row.no_decimation ?? false,
    reviewed: row.reviewed_at !== null,
  }))
}
