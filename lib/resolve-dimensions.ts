import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import {
  COMBINED_ATTRIBUTES,
  DEPTH_ATTRIBUTES,
  HEIGHT_ATTRIBUTES,
  UNDER_TOP_HEIGHT_ATTRIBUTES,
  UNDER_TOP_WIDTH_ATTRIBUTES,
  WIDTH_ATTRIBUTES,
  dimensionsConflict,
  matchesAttribute,
  parseDimensionTriple,
  parseDimensionValue,
} from '@/modules/space-planner-for-shop/lib/dimensions'
import {
  getCategoryDefaultsMap,
  getDimensionsForProducts,
  getPrimaryCategoryForProducts,
  saveDimensionsMany,
} from '@/modules/space-planner-for-shop/lib/db/dimension-cache'
import { getModelMetaForProducts } from '@/modules/space-planner-for-shop/lib/db/model-meta'
import { getSpecValues } from '@/modules/space-planner-for-shop/lib/spec-attributes'
import type { MountType, SizeSource, SplDimensions } from '@/modules/space-planner-for-shop/lib/types'

// The resolution ladder, in strict order:
//
//   1. Model bounding box - if a model exists, the mesh is truth. Measured
//      offline by scripts/calibrate.mjs, which loads every distinct model file
//      with node transforms applied and writes rows with source 'glb'. It cannot
//      happen here: a route has sixty seconds and a GLB averages four megabytes.
//   2. Parsed spec attributes - Overall Width/Depth/Height, read as text.
//   3. Category defaults - for the axes still missing. The item is badged
//      "approx. size" in the planner; never a silent guess.
//   4. Manual entry - whatever the shopper typed, which nothing here overwrites.
//   5. Generic marker - a labelled block, so adding something to a plan is never
//      blocked by our not knowing how big it is.
//
// Where a measured model and parsed attributes both exist and disagree by more
// than a tenth, the row is flagged. One of the two is wrong, and quietly
// preferring either is how you end up with a beautifully rendered room in which
// nothing is the size it claims.

/** The extra measurements that make "will this pedestal fit under this desk" answerable. */
export type UnderTop = { heightMm: number | null; widthMm: number | null }

export type ResolvedDimensions = SplDimensions & { underTop: UnderTop }

const DEFAULT_FALLBACK = { widthMm: 800, depthMm: 600, heightMm: 750 }

/** `IN (...)` over a caller-supplied list, kept behind a name so this file reads as SQL. */
function prismaIn(values: string[]): Prisma.Sql {
  return Prisma.join(values)
}

type ProductRow = { id: string; updated_at: Date }

/**
 * Resolve (and cache) dimensions for a set of products.
 *
 * `force` re-runs the ladder even for rows that look fresh - what the admin's
 * rebuild passes. Without it, only products whose own updated_at has moved since
 * we last measured them are touched, which is what makes this cheap enough to
 * call on every plan load.
 */
export async function resolveDimensions(productIds: string[], opts: { force?: boolean } = {}): Promise<Map<string, ResolvedDimensions>> {
  const out = new Map<string, ResolvedDimensions>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return out

  const [products, existing, specValues, categoryOf, categoryDefaults, productMeta] = await Promise.all([
    prisma.$queryRaw<ProductRow[]>`
      SELECT "id", "updated_at" FROM "shp_products" WHERE "id" IN (${prismaIn(ids)})
    `,
    getDimensionsForProducts(ids),
    getSpecValues(ids),
    getPrimaryCategoryForProducts(ids),
    getCategoryDefaultsMap(),
    getModelMetaForProducts(ids),
  ])

  const updatedAtById = new Map(products.map((row) => [row.id, row.updated_at]))
  // Banked and written once at the end rather than a round trip per product.
  const toSave: SplDimensions[] = []

  for (const id of ids) {
    const productUpdatedAt = updatedAtById.get(id) ?? null
    const cached = existing.get(id)

    const fresh =
      !opts.force &&
      cached &&
      !cached.stale &&
      cached.productUpdatedAt &&
      productUpdatedAt &&
      cached.productUpdatedAt.getTime() === productUpdatedAt.getTime()

    if (fresh && cached) {
      out.set(id, { ...cached, underTop: underTopFrom(specValues.get(id) ?? []) })
      continue
    }

    const resolved = resolveOne({
      productId: id,
      productUpdatedAt,
      cached: cached ?? null,
      values: specValues.get(id) ?? [],
      categoryId: categoryOf.get(id) ?? null,
      categoryDefaults,
      mountOverride: productMeta.get(id)?.mountType ?? null,
    })

    toSave.push(resolved)
    out.set(id, { ...resolved, underTop: underTopFrom(specValues.get(id) ?? []) })
  }

  if (toSave.length > 0) await saveDimensionsMany(toSave)

  return out
}

type ResolveInput = {
  productId: string
  productUpdatedAt: Date | null
  cached: SplDimensions | null
  values: Array<{ attribute: string; label: string }>
  categoryId: string | null
  categoryDefaults: Map<string, { widthMm: number | null; depthMm: number | null; heightMm: number | null; mountType: MountType }>
  mountOverride: MountType | null
}

/** The ladder itself, pulled out so it is one readable function rather than a loop body. */
export function resolveOne(input: ResolveInput): SplDimensions {
  const attribute = readAttributeDimensions(input.values)
  const categoryDefault = input.categoryId ? input.categoryDefaults.get(input.categoryId) ?? null : null

  // Rungs 1 and 4 are already in the row when they apply: a measured model was
  // written by the calibration pass, and a manual size was typed by the shopper.
  // Neither gets thrown away because a product's description changed - but the
  // attribute rung still runs, because it is what recomputes the disagreement
  // flag.
  const measured = input.cached && (input.cached.source === 'glb' || input.cached.source === 'manual') ? input.cached : null

  let widthMm: number | null
  let depthMm: number | null
  let heightMm: number | null
  let source: SizeSource
  let parsedFrom = ''

  if (measured) {
    widthMm = measured.widthMm
    depthMm = measured.depthMm
    heightMm = measured.heightMm
    source = measured.source
    parsedFrom = measured.parsedFrom
  } else if (attribute.widthMm !== null || attribute.depthMm !== null || attribute.heightMm !== null) {
    widthMm = attribute.widthMm
    depthMm = attribute.depthMm
    heightMm = attribute.heightMm
    source = 'attribute'
    parsedFrom = attribute.parsedFrom
  } else {
    widthMm = null
    depthMm = null
    heightMm = null
    source = 'marker'
    parsedFrom = attribute.junk
  }

  // Rung 3 fills the axes still missing, whatever answered the others. Seven
  // products in ten have no depth and no height, so without this the ladder
  // would fall past a perfectly good width straight to a generic marker.
  let usedDefault = false
  if (categoryDefault) {
    if (widthMm === null && categoryDefault.widthMm !== null) { widthMm = categoryDefault.widthMm; usedDefault = true }
    if (depthMm === null && categoryDefault.depthMm !== null) { depthMm = categoryDefault.depthMm; usedDefault = true }
    if (heightMm === null && categoryDefault.heightMm !== null) { heightMm = categoryDefault.heightMm; usedDefault = true }
  }

  // Rung 5. Something has to be placeable, so the last resort is a labelled
  // block of an ordinary size rather than a refusal.
  if (widthMm === null) { widthMm = DEFAULT_FALLBACK.widthMm; usedDefault = true }
  if (depthMm === null) { depthMm = DEFAULT_FALLBACK.depthMm; usedDefault = true }
  if (heightMm === null) { heightMm = DEFAULT_FALLBACK.heightMm; usedDefault = true }

  // Any axis that came off a fallback makes the whole size approximate, and the
  // planner says so - "never a silent guess" is the rule the whole ladder is
  // built around. This line used to assign 'attribute' to 'attribute', which is
  // nothing at all: a desk with a real width and a guessed depth was badged as
  // measured, on both the browse card and the item list.
  if (source === 'attribute' && usedDefault) source = 'category_default'
  if (source === 'marker' && usedDefault) source = categoryDefault ? 'category_default' : 'marker'

  const conflictNote = measured && measured.source === 'glb'
    ? dimensionsConflict(
        { widthMm: measured.widthMm, depthMm: measured.depthMm, heightMm: measured.heightMm },
        attribute,
      )
    : ''

  const mountType: MountType =
    input.mountOverride ?? categoryDefault?.mountType ?? 'floor'

  return {
    productId: input.productId,
    widthMm: Math.round(widthMm),
    depthMm: Math.round(depthMm),
    heightMm: Math.round(heightMm),
    source,
    parsedFrom,
    conflict: conflictNote !== '',
    conflictNote,
    mountType,
    productUpdatedAt: input.productUpdatedAt,
    stale: false,
    resolvedAt: new Date(),
  }
}

type AttributeDimensions = {
  widthMm: number | null
  depthMm: number | null
  heightMm: number | null
  parsedFrom: string
  /** What the parser choked on, so the junk tail can show a human the real text. */
  junk: string
}

export function readAttributeDimensions(values: Array<{ attribute: string; label: string }>): AttributeDimensions {
  const result: AttributeDimensions = { widthMm: null, depthMm: null, heightMm: null, parsedFrom: '', junk: '' }
  const used: string[] = []
  const junk: string[] = []

  for (const value of values) {
    const axes: Array<[string[], 'widthMm' | 'depthMm' | 'heightMm']> = [
      [WIDTH_ATTRIBUTES, 'widthMm'],
      [DEPTH_ATTRIBUTES, 'depthMm'],
      [HEIGHT_ATTRIBUTES, 'heightMm'],
    ]
    let handled = false
    for (const [names, axis] of axes) {
      if (!matchesAttribute(value.attribute, names)) continue
      handled = true
      if (result[axis] !== null) break
      const parsed = parseDimensionValue(value.label)
      if (parsed.ok) {
        result[axis] = parsed.mm
        used.push(`${value.attribute}: ${value.label}`)
      } else {
        junk.push(`${value.attribute}: ${value.label}`)
      }
      break
    }
    if (handled) continue

    if (matchesAttribute(value.attribute, COMBINED_ATTRIBUTES)) {
      const triple = parseDimensionTriple(value.label)
      if (triple) {
        if (result.widthMm === null) result.widthMm = triple.widthMm
        if (result.depthMm === null) result.depthMm = triple.depthMm
        if (result.heightMm === null) result.heightMm = triple.heightMm
        used.push(`${value.attribute}: ${value.label}`)
      } else {
        junk.push(`${value.attribute}: ${value.label}`)
      }
    }
  }

  result.parsedFrom = used.join(' | ')
  result.junk = junk.join(' | ')
  return result
}

/**
 * "Height Under Top" and "Width Under Top" - present on a couple of thousand
 * products, and the difference between "these overlap" and "that pedestal is
 * 5 cm too tall to go under that desk".
 */
export function underTopFrom(values: Array<{ attribute: string; label: string }>): UnderTop {
  const out: UnderTop = { heightMm: null, widthMm: null }
  for (const value of values) {
    if (out.heightMm === null && matchesAttribute(value.attribute, UNDER_TOP_HEIGHT_ATTRIBUTES)) {
      const parsed = parseDimensionValue(value.label)
      if (parsed.ok) out.heightMm = parsed.mm
    }
    if (out.widthMm === null && matchesAttribute(value.attribute, UNDER_TOP_WIDTH_ATTRIBUTES)) {
      const parsed = parseDimensionValue(value.label)
      if (parsed.ok) out.widthMm = parsed.mm
    }
  }
  return out
}
