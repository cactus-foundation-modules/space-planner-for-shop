import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import {
  COMBINED_ATTRIBUTES,
  DEPTH_ATTRIBUTES,
  HEIGHT_ATTRIBUTES,
  MAX_PLAUSIBLE_MM,
  MIN_PLAUSIBLE_MM,
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
import { getSpecValues, getVariationParents } from '@/modules/space-planner-for-shop/lib/spec-attributes'
import type { SpecValue } from '@/modules/space-planner-for-shop/lib/spec-attributes'
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
//   4. Manual entry - a size somebody typed, which nothing here overwrites.
//      Nothing WRITES it either: a shopper's typed size lives on the plan item
//      itself (PlanItem.manualSize) and never reaches this cache, so no row has
//      ever carried source 'manual'. The guards below still honour it, because
//      the day an admin screen offers to correct a size is the day they matter
//      and a rung that is enforced-but-unused costs nothing until then.
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

  // The listing behind each placed variant, resolved first because its spec
  // values have to be read in the SAME round as the children's.
  const parentOf = await getVariationParents(ids)
  const withParents = [...new Set([...ids, ...parentOf.values()])]

  const [products, existing, specValues, categoryOf, categoryDefaults, productMeta] = await Promise.all([
    prisma.$queryRaw<ProductRow[]>`
      SELECT "id", "updated_at" FROM "shp_products" WHERE "id" IN (${prismaIn(withParents)})
    `,
    getDimensionsForProducts(ids),
    getSpecValues(withParents),
    getPrimaryCategoryForProducts(withParents),
    getCategoryDefaultsMap(),
    getModelMetaForProducts(ids),
  ])

  // Child first, listing second. readAttributeDimensions takes the first match
  // per axis, so a variation that states its own width keeps it and one that
  // states nothing inherits the range's - which is what makes a per-width desk
  // and a one-size-fits-all chair both come out right.
  const valuesFor = (id: string): SpecValue[] => {
    const own = specValues.get(id) ?? []
    const parentId = parentOf.get(id)
    const inherited = parentId ? specValues.get(parentId) ?? [] : []
    return inherited.length > 0 ? [...own, ...inherited] : own
  }

  const updatedAtById = new Map(products.map((row) => [row.id, row.updated_at]))

  // A child's size can now come off its LISTING's spec sheet, so the listing
  // moving has to make the child stale too - correcting an Overall Width on the
  // listing must not leave every variation in the room at the old size.
  //
  // Deliberately NOT banked into product_updated_at. That column is compared
  // against shp_products.updated_at by the sweep's own SQL, and writing a
  // parent's stamp into a child's row would make every such child look
  // permanently stale and re-resolve on every pass, for ever. So the parent is
  // checked here, against when this row was last worked out.
  const parentMovedSince = (id: string, resolvedAt: Date | null): boolean => {
    const parentId = parentOf.get(id)
    if (!parentId || !resolvedAt) return false
    const parent = updatedAtById.get(parentId)
    return parent ? parent.getTime() > resolvedAt.getTime() : false
  }
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
      cached.productUpdatedAt.getTime() === productUpdatedAt.getTime() &&
      !parentMovedSince(id, cached.resolvedAt)

    const values = valuesFor(id)

    if (fresh && cached) {
      out.set(id, { ...cached, underTop: underTopFrom(values) })
      continue
    }

    const resolved = resolveOne({
      productId: id,
      productUpdatedAt,
      cached: cached ?? null,
      values,
      // A variation child is rarely filed under a category of its own; the
      // listing is what carries them. Falling back to the listing's is what
      // stops a placed variant dropping past a perfectly good category default
      // to the generic block.
      categoryId: categoryOf.get(id) ?? (parentOf.get(id) ? categoryOf.get(parentOf.get(id) as string) ?? null : null),
      categoryDefaults,
      mountOverride: productMeta.get(id)?.mountType ?? null,
    })

    // Answered, but only BANKED for a product that actually exists. An id with
    // no product row can never satisfy the freshness test above (there is no
    // updatedAt to match), so it resolved and saved on every single call - and
    // this route takes up to four hundred caller-chosen ids, so invented ones
    // wrote junk rows that inflated every figure in the admin size report until
    // the nightly sweep removed them, whereupon the next request wrote them
    // again. applyMeasurements has guarded the same case from the start.
    if (updatedAtById.has(id)) toSave.push(resolved)
    out.set(id, { ...resolved, underTop: underTopFrom(values) })
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
    parsedFrom = ''
  }

  // Rung 3 fills the axes still missing, whatever answered the others. Seven
  // products in ten have no depth and no height, so without this the ladder
  // would fall past a perfectly good width straight to a generic marker.
  let usedCategoryDefault = false
  if (categoryDefault) {
    if (widthMm === null && categoryDefault.widthMm !== null) { widthMm = categoryDefault.widthMm; usedCategoryDefault = true }
    if (depthMm === null && categoryDefault.depthMm !== null) { depthMm = categoryDefault.depthMm; usedCategoryDefault = true }
    if (heightMm === null && categoryDefault.heightMm !== null) { heightMm = categoryDefault.heightMm; usedCategoryDefault = true }
  }

  // Rung 5. Something has to be placeable, so the last resort is a labelled
  // block of an ordinary size rather than a refusal.
  let usedGenericBlock = false
  if (widthMm === null) { widthMm = DEFAULT_FALLBACK.widthMm; usedGenericBlock = true }
  if (depthMm === null) { depthMm = DEFAULT_FALLBACK.depthMm; usedGenericBlock = true }
  if (heightMm === null) { heightMm = DEFAULT_FALLBACK.heightMm; usedGenericBlock = true }

  // Any axis that came off a fallback makes the whole size approximate, and the
  // planner says so - "never a silent guess" is the rule the whole ladder is
  // built around. WHICH fallback answered decides the badge, and only a category
  // that actually supplied a measurement earns "typical for its category":
  // testing the row rather than what it supplied meant a default saved with all
  // three sizes blank re-badged every product under it as though somebody had
  // measured the category, when the generic block was still doing all the work.
  if (source === 'attribute' || source === 'marker') {
    if (usedCategoryDefault) source = 'category_default'
    else if (usedGenericBlock) source = 'marker'
  }

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
    // Recorded whatever else answered. A product can state a readable width and
    // an unreadable height, and that height is the whole reason the junk tail
    // exists - it used to be computed and dropped on the floor unless NOTHING
    // parsed, which is the one case that never has any text to show.
    junkText: attribute.junk,
    conflict: conflictNote !== '',
    conflictNote,
    mountType,
    productUpdatedAt: input.productUpdatedAt,
    stale: false,
    resolvedAt: new Date(),
  }
}

// ---------------------------------------------------------------------------
// Rung 1: the measured model
// ---------------------------------------------------------------------------

/** One model, measured with its node transforms and its yaw correction applied. */
export type Measurement = { productId: string; widthMm: number; depthMm: number; heightMm: number }

export type MeasurementResult = { written: number; skipped: number; conflicts: number }

function measurementPlausible(entry: Measurement): boolean {
  return [entry.widthMm, entry.depthMm, entry.heightMm].every(
    (mm) => Number.isFinite(mm) && mm >= MIN_PLAUSIBLE_MM && mm <= MAX_PLAUSIBLE_MM,
  )
}

/**
 * Bank measured models as rung 1 of the ladder.
 *
 * The measuring itself cannot happen on a route - a route has sixty seconds and
 * these files average four megabytes - so it happens in a browser, with the same
 * code that draws them, and lands here. Which is the point: the number written
 * is the extent of the mesh the planner actually puts in the room, not a second
 * opinion about it taken by some other pipeline.
 *
 * Two things it will not do. It will not overwrite a size the owner typed by
 * hand - rung 4 outranks rung 1 precisely because somebody looked at the thing.
 * And it will not write an implausible measurement: a file exported in
 * centimetres measures forty metres across, and forty metres of desk in a
 * customer's floor plan is worse than no desk at all.
 */
export async function applyMeasurements(measurements: Measurement[]): Promise<MeasurementResult> {
  const usable = measurements.filter(measurementPlausible)
  const ids = [...new Set(usable.map((entry) => entry.productId))]
  if (ids.length === 0) return { written: 0, skipped: measurements.length, conflicts: 0 }

  const parentOf = await getVariationParents(ids)
  const withParents = [...new Set([...ids, ...parentOf.values()])]

  const [products, existing, specValues, categoryOf, categoryDefaults, productMeta] = await Promise.all([
    prisma.$queryRaw<ProductRow[]>`
      SELECT "id", "updated_at" FROM "shp_products" WHERE "id" IN (${prismaIn(ids)})
    `,
    getDimensionsForProducts(ids),
    getSpecValues(withParents),
    getPrimaryCategoryForProducts(withParents),
    getCategoryDefaultsMap(),
    getModelMetaForProducts(ids),
  ])

  const updatedAtById = new Map(products.map((row) => [row.id, row.updated_at]))
  const toSave: SplDimensions[] = []
  let conflicts = 0
  let skipped = measurements.length - usable.length

  const seen = new Set<string>()
  for (const entry of usable) {
    if (seen.has(entry.productId)) continue
    seen.add(entry.productId)
    if (!updatedAtById.has(entry.productId)) { skipped += 1; continue }
    if (existing.get(entry.productId)?.source === 'manual') { skipped += 1; continue }

    const own = specValues.get(entry.productId) ?? []
    const parentId = parentOf.get(entry.productId)
    const inherited = parentId ? specValues.get(parentId) ?? [] : []
    const attribute = readAttributeDimensions(inherited.length > 0 ? [...own, ...inherited] : own)

    const note = dimensionsConflict(
      { widthMm: entry.widthMm, depthMm: entry.depthMm, heightMm: entry.heightMm },
      attribute,
    )
    if (note) conflicts += 1

    const categoryId = categoryOf.get(entry.productId) ?? (parentId ? categoryOf.get(parentId) ?? null : null)
    const categoryDefault = categoryId ? categoryDefaults.get(categoryId) ?? null : null

    toSave.push({
      productId: entry.productId,
      widthMm: Math.round(entry.widthMm),
      depthMm: Math.round(entry.depthMm),
      heightMm: Math.round(entry.heightMm),
      source: 'glb',
      parsedFrom: attribute.parsedFrom,
      junkText: attribute.junk,
      conflict: note !== '',
      conflictNote: note,
      mountType: productMeta.get(entry.productId)?.mountType ?? categoryDefault?.mountType ?? 'floor',
      productUpdatedAt: updatedAtById.get(entry.productId) ?? null,
      stale: false,
      resolvedAt: new Date(),
    })
  }

  if (toSave.length > 0) await saveDimensionsMany(toSave)
  return { written: toSave.length, skipped, conflicts }
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

  // Preference order is walked per AXIS, not per value.
  //
  // The other way round - which is what this did - never reads the position of
  // a name in its list, so a product carrying both "Overall Height (Spec)" and
  // "Overall Height" gets whichever the database happened to hand back first.
  // That is heap order: no ORDER BY reaches these rows, and on Deskwell it
  // split 168 products to the preferred name and 126 to the second, with 294
  // of them publishing genuinely different figures (a Chiro task chair says
  // 108 cm one way and 110.4 cm the other). Worse, it is not even stable - a
  // bulk update or a table rewrite reshuffles the heap and flips the answer for
  // a different subset, silently, on the next rebuild.
  //
  // A name that is present but unparseable does not block the rest of its list:
  // "Overall Height (Spec): please enquire" falls through to "Overall Height",
  // which is the behaviour a shopper would expect and the old loop happened to
  // have as well.
  const axes: Array<[string[], 'widthMm' | 'depthMm' | 'heightMm']> = [
    [WIDTH_ATTRIBUTES, 'widthMm'],
    [DEPTH_ATTRIBUTES, 'depthMm'],
    [HEIGHT_ATTRIBUTES, 'heightMm'],
  ]
  for (const [names, axis] of axes) {
    for (const name of names) {
      if (result[axis] !== null) break
      for (const value of values) {
        if (value.attribute.trim().toLowerCase() !== name) continue
        const parsed = parseDimensionValue(value.label)
        if (parsed.ok) {
          result[axis] = parsed.mm
          used.push(`${value.attribute}: ${value.label}`)
          break
        }
        junk.push(`${value.attribute}: ${value.label}`)
      }
    }
  }

  const axisNames = new Set([...WIDTH_ATTRIBUTES, ...DEPTH_ATTRIBUTES, ...HEIGHT_ATTRIBUTES])
  for (const value of values) {
    if (axisNames.has(value.attribute.trim().toLowerCase())) continue

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
