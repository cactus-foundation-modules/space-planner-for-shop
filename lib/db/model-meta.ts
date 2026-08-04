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

export async function upsertFileMeta(
  modelId: string,
  patch: { yawOffsetDegrees?: number; footprintOverride?: { widthMm: number; depthMm: number } | null; noDecimation?: boolean; notes?: string; reviewed?: boolean },
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "spl_model_meta" ("scope", "model_id", "yaw_offset_degrees", "footprint_override", "no_decimation", "notes", "reviewed_at")
    VALUES (
      'file',
      ${modelId},
      ${patch.yawOffsetDegrees ?? 0},
      ${patch.footprintOverride ? JSON.stringify(patch.footprintOverride) : null}::jsonb,
      ${patch.noDecimation ?? false},
      ${patch.notes ?? ''},
      ${patch.reviewed ? new Date() : null}
    )
    ON CONFLICT ("model_id") DO UPDATE SET
      "yaw_offset_degrees" = COALESCE(${patch.yawOffsetDegrees ?? null}, "spl_model_meta"."yaw_offset_degrees"),
      "footprint_override" = ${patch.footprintOverride === undefined ? null : patch.footprintOverride ? JSON.stringify(patch.footprintOverride) : null}::jsonb,
      "no_decimation" = COALESCE(${patch.noDecimation ?? null}, "spl_model_meta"."no_decimation"),
      "notes" = COALESCE(${patch.notes ?? null}, "spl_model_meta"."notes"),
      "reviewed_at" = ${patch.reviewed ? new Date() : null},
      "updated_at" = CURRENT_TIMESTAMP
  `
}

export async function upsertProductMeta(
  productId: string,
  patch: { mountType?: MountType | null; notes?: string; reviewed?: boolean },
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "spl_model_meta" ("scope", "product_id", "mount_type", "notes", "reviewed_at")
    VALUES ('product', ${productId}, ${patch.mountType ?? null}, ${patch.notes ?? ''}, ${patch.reviewed ? new Date() : null})
    ON CONFLICT ("product_id") DO UPDATE SET
      "mount_type" = ${patch.mountType ?? null},
      "notes" = COALESCE(${patch.notes ?? null}, "spl_model_meta"."notes"),
      "reviewed_at" = ${patch.reviewed ? new Date() : null},
      "updated_at" = CURRENT_TIMESTAMP
  `
}

/**
 * The worst-offenders view the admin sorts on: modelled products nobody has
 * looked at yet, most-placed first. Upkeep is worth ten minutes when it is
 * pointed at the twelve models customers actually use, and worth nothing at all
 * when it is a list of two hundred and fifty in alphabetical order.
 */
export async function listUnreviewedModels(limit = 50): Promise<Array<{ modelId: string; productId: string; url: string; format: string; placements: number }>> {
  const rows = await prisma.$queryRaw<Array<{ model_id: string; product_id: string; url: string; format: string; placements: bigint }>>`
    SELECT m."id" AS model_id, m."product_id", m."url", m."format",
           COALESCE((SELECT COUNT(*) FROM "spl_events" e WHERE e."product_id" = m."product_id" AND e."event" = 'item.placed'), 0)::bigint AS placements
    FROM "p3d_models" m
    LEFT JOIN "spl_model_meta" meta ON meta."model_id" = m."id"
    WHERE meta."id" IS NULL OR meta."reviewed_at" IS NULL
    ORDER BY placements DESC, m."created_at" DESC
    LIMIT ${limit}
  `
  return rows.map((row) => ({
    modelId: row.model_id,
    productId: row.product_id,
    url: row.url,
    format: row.format,
    placements: Number(row.placements),
  }))
}
