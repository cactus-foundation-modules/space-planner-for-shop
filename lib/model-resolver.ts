import { signAssetUrl } from '@/lib/media/asset-token'
import { getFabricConfig } from '@/modules/product-3d-views-for-shop/lib/db/fabric-config'
import { getModelsForProducts, getVariationChildrenForProducts } from '@/modules/product-3d-views-for-shop/lib/db/models'
import { resolveFabricForChild } from '@/modules/product-3d-views-for-shop/lib/fabric/resolve'
import type { FabricBundle } from '@/modules/product-3d-views-for-shop/lib/types'
import { getModelMetaForModels, getModelMetaForProducts } from '@/modules/space-planner-for-shop/lib/db/model-meta'
import { plainUrl } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { ResolvedModel } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import { getFirstVariationChildren, getVariationParents } from '@/modules/space-planner-for-shop/lib/spec-attributes'
import type { FabricSlot } from '@/modules/space-planner-for-shop/lib/three/planner-model'
import type { MountType } from '@/modules/space-planner-for-shop/lib/types'

// Which file draws which product, in which colours, and the fix-ups that go with
// them.
//
// Two urls come back for every model and they are not interchangeable:
//
//   plainUrl - the query-stripped public url. This is the CACHE KEY, and the
//     only thing that may ever be persisted or compared. The catalogue stores
//     one chair file under dozens of different stale signatures, so keyed on the
//     raw url a plan would download one file once per row that mentions it.
//   fetchUrl - freshly signed, valid for a couple of days, minted per response
//     and never stored anywhere.
//
// Getting these the wrong way round is the mistake this module is designed to
// make impossible: the type has no field a signed url could hide in.
//
// The colours are the other half. Most of this catalogue is one model file per
// SHAPE, with the fabric painted on at view time from the shopper's chosen
// swatch - which is why the planner spent its first three releases drawing a
// room full of white chairs while the product page beside it showed them in
// blue. p3d already resolves those paints for its own viewer; this asks it for
// the same answer and hands it on.

export type PlannerModel = ResolvedModel & {
  /** Freshly signed, for this response only. Never persisted, never a cache key. */
  fetchUrl: string
  /**
   * The add-on combination this entry draws ('' = the base model). A variant
   * lives in the map under plannerModelKey(productId, context), beside - never
   * instead of - the product's base entry.
   */
  context: string
  mountOverride: MountType | null
  /** The paints for this exact variation. Empty for a product with no fabric config. */
  slots: FabricSlot[]
  /**
   * The product's real overall size along `realAxis`, in metres - p3d's `realCm`
   * for this variation, which is the owner's own statement of how big the thing
   * is and the number its fabric already tiles to. Null where the shop has not
   * set one, or where the size source did not resolve.
   *
   * Carried because it is the best size the planner can draw a model at: the
   * spec sheet describes the product, this describes the FILE, and it is the file
   * that has to end up the right size in a room.
   */
  realMetres: number | null
  realAxis: 'height' | 'width'
}

/**
 * How many variations may have their paints resolved in one request.
 *
 * Each one is a handful of queries against the variations and attributes tables,
 * and the honest budget is "a roomful", not "a catalogue". Past it the remaining
 * products still draw - in the file's own colours, which is exactly what every
 * release before this one did for all of them.
 */
const MAX_FABRIC_RESOLUTIONS = 60

/** How many of those to have in flight at once. See the loop at the end of resolveFabric. */
const FABRIC_CONCURRENCY = 6

// Resolved bundles, held briefly per server instance.
//
// Working one variation's paints out is around eight queries against the
// variations and attributes tables, one of which reads the shop's whole swatch
// vocabulary - and the planner asks for the same roomful again on every load,
// every save and every render. Without this, a twenty-product room paid for a
// hundred and sixty queries to arrive at the answer it had a moment ago.
//
// A minute is the same bargain p3d's own fabric route makes with its cache
// header: a colour changed in the admin shows up on the next load, not this one.
const FABRIC_TTL_MS = 60_000
const FABRIC_CACHE_MAX = 500
const fabricCache = new Map<string, { at: number; bundle: FabricBundle | null }>()

function readFabricCache(key: string): { bundle: FabricBundle | null } | null {
  const hit = fabricCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > FABRIC_TTL_MS) {
    fabricCache.delete(key)
    return null
  }
  return hit
}

function writeFabricCache(key: string, bundle: FabricBundle | null): void {
  // Oldest out first. A Map iterates in insertion order, so this is the whole
  // eviction policy and it does not need to be cleverer than that.
  if (fabricCache.size >= FABRIC_CACHE_MAX) {
    const oldest = fabricCache.keys().next().value
    if (oldest !== undefined) fabricCache.delete(oldest)
  }
  fabricCache.set(key, { at: Date.now(), bundle })
}

/** Test seam, and the thing to call if a fabric config is ever saved in-process. */
export function clearFabricCache(): void {
  fabricCache.clear()
}

/** Short, stable, and only ever used as a key - never parsed back. */
function fabricKeyFor(slots: FabricSlot[]): string {
  if (slots.length === 0) return ''
  const canonical = JSON.stringify(
    [...slots]
      .sort((a, b) => a.materialName.localeCompare(b.materialName))
      .map((slot) => [slot.materialName, slot.textureUrl, slot.colour, slot.repeat, slot.rotationDeg, slot.gloss, slot.autoScale]),
  )
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

function toSlots(bundle: FabricBundle | null): FabricSlot[] {
  if (!bundle) return []
  return bundle.slots.map((slot) => ({
    materialName: slot.materialName,
    textureUrl: slot.textureUrl,
    colour: slot.colour,
    repeat: slot.repeat,
    rotationDeg: slot.rotationDeg ?? 0,
    gloss: slot.gloss ?? 0,
    autoScale: slot.autoScale ?? null,
  }))
}

/**
 * The paints for each of these products, where the shop has configured any.
 *
 * Resolved from the LISTING's config and the CHILD's chosen values, which is the
 * split p3d uses: the config says "this material is painted from the Seat Colour
 * option", and the variation says which value of it this one is.
 */
async function resolveFabric(productIds: string[]): Promise<Map<string, FabricBundle>> {
  const out = new Map<string, FabricBundle>()
  if (productIds.length === 0) return out

  // Everything already known is answered before a single table is touched: a
  // room whose products are all in the cache costs nothing at all.
  const unknown: string[] = []
  for (const id of productIds) {
    const hit = readFabricCache(id)
    if (!hit) unknown.push(id)
    else if (hit.bundle) out.set(id, hit.bundle)
  }
  if (unknown.length === 0) return out

  const parentOf = await getVariationParents(unknown)
  // Anything that is not somebody's variation is a listing in its own right -
  // and the browse panel places those, so they need colours too.
  const listingIds = unknown.filter((id) => !parentOf.has(id))
  const standInFor = await getFirstVariationChildren(listingIds)

  // Which listing's config answers for each placed product, and which variation
  // states the actual choices.
  const jobs: Array<{ placedId: string; childId: string; parentId: string }> = []
  for (const id of unknown) {
    const parentId = parentOf.get(id)
    if (parentId) jobs.push({ placedId: id, childId: id, parentId })
    else {
      const standIn = standInFor.get(id)
      if (standIn) jobs.push({ placedId: id, childId: standIn, parentId: id })
      // Nothing to paint, and worth remembering: a plain product asked about
      // once a second must not re-derive that fact every time.
      else writeFabricCache(id, null)
    }
  }
  if (jobs.length === 0) return out

  // One config lookup per LISTING, not per variation: twelve colours of the same
  // chair share one.
  const configs = new Map<string, Awaited<ReturnType<typeof getFabricConfig>>>()
  for (const parentId of new Set(jobs.map((job) => job.parentId))) {
    configs.set(parentId, await getFabricConfig(parentId))
  }

  // Deterministic order, so a room that is over the budget loses the same
  // products' colours on every load rather than a different set each time.
  const withConfig = jobs.filter((job) => Boolean(configs.get(job.parentId)))
  for (const job of jobs) if (!configs.get(job.parentId)) writeFabricCache(job.placedId, null)

  const candidates = withConfig
    .sort((a, b) => a.placedId.localeCompare(b.placedId))
    .slice(0, MAX_FABRIC_RESOLUTIONS)

  // A few at a time, not all at once. Each resolve is around eight queries, so
  // a roomful fired off in parallel is a hundred and sixty of them arriving
  // together at a connection pooler that has rather fewer connections than that.
  for (let start = 0; start < candidates.length; start += FABRIC_CONCURRENCY) {
    await Promise.all(
      candidates.slice(start, start + FABRIC_CONCURRENCY).map(async (job) => {
        const config = configs.get(job.parentId)
        if (!config) return
        try {
          const bundle = await resolveFabricForChild(job.childId, job.parentId, config)
          const usable = bundle && bundle.slots.length > 0 ? bundle : null
          writeFabricCache(job.placedId, usable)
          if (usable) out.set(job.placedId, usable)
        } catch {
          // A product whose colours will not resolve draws in the file's own
          // finish. That is a duller chair, not a broken room. Deliberately NOT
          // cached: a failure is a reason to try again, not a fact about the
          // product.
        }
      }),
    )
  }

  return out
}

// The map key a context variant is stored under. Base models keep the bare
// productId (every consumer that predates contexts reads exactly what it always
// did); a combined-model variant lives beside it under this composite. The
// separator can never appear in an id or a context tag (both are slug-grammar).
export function plannerModelKey(productId: string, context: string): string {
  return context ? `${productId}@@${context}` : productId
}

export async function resolveModelsForProducts(
  productIds: string[],
  // The measuring pass wants files and nothing else: paint does not move a
  // bounding box, and resolving colours for every model in the catalogue would
  // be several hundred queries spent on a number that cannot change.
  opts: {
    withFabric?: boolean
    // Add-on combinations to resolve ALONGSIDE the base models: for each entry
    // the tagged file (exact-or-base) and its paints land in the map under
    // plannerModelKey(productId, context). Base entries are never displaced.
    contexts?: Array<{ productId: string; context: string; extraValueIds: string[] }>
  } = {},
): Promise<Map<string, PlannerModel>> {
  const out = new Map<string, PlannerModel>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return out

  // A listing's model usually hangs off its variations rather than off the
  // listing itself - which is why the browse panel counts a listing as modelled
  // when any of its children is. Asking only about the listing put a "3D" badge
  // on a card and then drew a plain box in the room, which is the sort of small
  // lie that costs a shopper their trust in the whole tool. So: the listing's own
  // model where there is one, otherwise the first of its children's.
  //
  // Two set-wide queries for the children, never one per product - the batched
  // primitives exist precisely because a plan can reference a couple of hundred
  // products.
  const own = await getModelsForProducts(ids)
  const answered = new Set(own.map((model) => model.productId))
  const unanswered = ids.filter((id) => !answered.has(id))

  const childModels: typeof own = []
  const childToParent = new Map<string, string>()
  if (unanswered.length > 0) {
    const children = await getVariationChildrenForProducts(unanswered)
    const childIds: string[] = []
    for (const [parentId, list] of children) {
      for (const childId of list) {
        // First parent wins: a child belongs to one listing, and if the data ever
        // says otherwise the planner must not silently pick a different one on
        // every request.
        if (!childToParent.has(childId)) childToParent.set(childId, parentId)
        childIds.push(childId)
      }
    }
    if (childIds.length > 0) childModels.push(...(await getModelsForProducts(childIds)))
  }

  // Children's models are re-keyed onto the listing the shopper actually placed,
  // so everything downstream - instancing, the byte budget, the cache - keys on
  // the product in the plan.
  const models = [
    ...own,
    ...childModels.map((model) => ({ ...model, productId: childToParent.get(model.productId) ?? model.productId })),
  ]
  if (models.length === 0) return out

  // Only products that actually draw a model are worth resolving colours for.
  const modelled = [...new Set(models.map((model) => model.productId))]
  const fabric = opts.withFabric === false ? new Map<string, FabricBundle>() : await resolveFabric(modelled)

  const [fileMeta, productMeta] = await Promise.all([
    getModelMetaForModels([
      ...models.map((model) => model.id),
      // A fabric bundle names the model its config was measured against, and
      // that model's own fix-ups still apply.
      ...[...fabric.values()].map((bundle) => bundle.modelId),
    ]),
    getModelMetaForProducts(ids),
  ])

  // One model per product: the first by position, which is p3d's own ordering
  // and therefore the one the product page shows first. A planner placing the
  // second-choice model would be a puzzle nobody could debug from the outside.
  const seen = new Set<string>()
  for (const model of models) {
    if (seen.has(model.productId)) continue
    seen.add(model.productId)

    // Where the product has fabric, the bundle's model is the one to draw:
    // material names are what the paints are addressed by, and painting them
    // onto a different file of the same product silently does nothing at all.
    const bundle = fabric.get(model.productId) ?? null
    const chosen = bundle
      ? { id: bundle.modelId, url: bundle.modelUrl, format: bundle.format as ResolvedModel['format'] }
      : { id: model.id, url: model.url, format: model.format as ResolvedModel['format'] }

    const file = fileMeta.get(chosen.id)
    const product = productMeta.get(model.productId)
    const plain = plainUrl(chosen.url)
    const slots = toSlots(bundle)

    out.set(model.productId, {
      productId: model.productId,
      context: '',
      plainUrl: plain,
      fetchUrl: signAssetUrl(plain),
      format: chosen.format,
      yawOffsetDeg: file?.yawOffsetDegrees ?? 0,
      noDecimation: file?.noDecimation ?? false,
      fabricKey: fabricKeyFor(slots),
      mountOverride: product?.mountType ?? null,
      slots,
      // Centimetres on the way in, metres out: the scene works in metres and
      // converting at one end only is how this stays readable.
      realMetres: bundle?.realCm ? bundle.realCm / 100 : null,
      realAxis: bundle?.scaleAxis ?? 'height',
    })
  }

  // Combined-model variants, resolved after (and beside) the base entries.
  //
  // "Few per room by nature" was the reasoning for doing these one at a time
  // through p3d's single-child resolver, and it is true of a room somebody built
  // by hand. It is not true of the schema's cap: this route takes eighty
  // contexts, each of which was three sequential queries warm and around eleven
  // cold, so a shopper arriving from a basket full of desks-with-screens paid
  // two hundred and forty round trips in a row - on an unauthenticated route,
  // with a sixty-second ceiling and a connection pooler the whole storefront
  // shares. The three lookups that do not depend on each other are now done for
  // the whole set at once, and the fabric resolves go through the same wave loop
  // resolveFabric uses, for the same reason it uses one.
  // Deduplicated by the key they will be stored under, which the old loop got
  // for free by testing `out` on each iteration: a plan holding six identical
  // desks-with-screens sends one request per grouped line, and without this the
  // batch would resolve the same combination six times over - concurrently, so
  // all six would miss the cache the first would otherwise have filled.
  const requests = [
    ...new Map(
      (opts.contexts ?? [])
        .filter((request) => request.context && !out.has(plannerModelKey(request.productId, request.context)))
        .map((request) => [plannerModelKey(request.productId, request.context), request]),
    ).values(),
  ]
  if (requests.length > 0) {
    const contextIds = [...new Set(requests.map((request) => request.productId))]
    const contextParents = await getVariationParents(contextIds)
    const parentFor = (productId: string): string => contextParents.get(productId) ?? productId
    const tagged = await getModelsForProducts(
      [...new Set(contextIds.flatMap((productId) => [productId, parentFor(productId)]))],
      { includeContexts: true },
    )

    // Child first, then listing - the same two shelves, and the same exact-match
    // rule, p3d's own resolver checks.
    const pending: Array<{ request: (typeof requests)[number]; model: (typeof tagged)[number] }> = []
    for (const request of requests) {
      const parentId = parentFor(request.productId)
      const model =
        tagged.find((m) => m.productId === request.productId && m.context === request.context) ??
        tagged.find((m) => m.productId === parentId && m.context === request.context)
      // No tagged file: nothing is stored, the scene's lookup falls back to the
      // base entry, and the room shows the plain product - exact-or-base.
      if (model) pending.push({ request, model })
    }

    if (pending.length > 0) {
      const fileMeta = await getModelMetaForModels([...new Set(pending.map((entry) => entry.model.id))])
      for (let start = 0; start < pending.length; start += FABRIC_CONCURRENCY) {
        await Promise.all(
          pending.slice(start, start + FABRIC_CONCURRENCY).map(async ({ request, model }) => {
            try {
              const variant = await buildContextVariant(
                request,
                model,
                parentFor(request.productId),
                fileMeta.get(model.id) ?? null,
                out.get(request.productId) ?? null,
              )
              if (variant) out.set(plannerModelKey(request.productId, request.context), variant)
            } catch {
              // A combination that will not resolve draws as the base model.
            }
          }),
        )
      }
    }
  }

  return out
}

// One add-on combination for one placed product: the paints for its exact
// context (companion values included) hung on a tagged file the caller has
// already found. Cached alongside the fabric cache with the context in the key,
// for the same reload-churn reason.
//
// The tagged file, the listing behind the variant and the file's own metadata
// are all passed in rather than looked up here: they are the three lookups that
// do not depend on each other, so the caller does them once for the whole set
// instead of three times per context in a row.
async function buildContextVariant(
  request: { productId: string; context: string; extraValueIds: string[] },
  model: { id: string; url: string; format: string },
  parentId: string,
  file: { yawOffsetDegrees: number; noDecimation: boolean } | null,
  base: PlannerModel | null,
): Promise<PlannerModel | null> {
  const cacheKey = `${request.productId}|${request.context}|${request.extraValueIds.join(',')}`
  let bundle: FabricBundle | null
  const hit = readFabricCache(cacheKey)
  if (hit) {
    bundle = hit.bundle
  } else {
    const config = await getFabricConfig(parentId)
    bundle = config
      ? await resolveFabricForChild(request.productId, parentId, config, {
          context: request.context,
          extraValueIds: request.extraValueIds,
        })
      : null
    writeFabricCache(cacheKey, bundle && bundle.slots.length > 0 ? bundle : null)
  }
  const usable = bundle && bundle.slots.length > 0 ? bundle : null

  const plain = plainUrl(usable?.modelUrl ?? model.url)
  const slots = toSlots(usable)
  return {
    productId: request.productId,
    context: request.context,
    plainUrl: plain,
    fetchUrl: signAssetUrl(plain),
    format: (usable?.format ?? model.format) as ResolvedModel['format'],
    yawOffsetDeg: file?.yawOffsetDegrees ?? 0,
    noDecimation: file?.noDecimation ?? false,
    fabricKey: fabricKeyFor(slots),
    // The product's own mount, inherited from its base entry: a wall-hung unit
    // is still wall-hung when it is drawn with its add-ons on.
    mountOverride: base?.mountOverride ?? null,
    slots,
    // The base product's recorded size only applies when this variant is drawing
    // the base product's FILE. A combined desk-and-screens model is a different
    // file with a different bounding box, and the recorded height is the desk's
    // alone: calling the taller mesh 73 cm scaled the whole assembly, screens
    // included, down by the ratio of the two. Where the context has no size of
    // its own, null sends it down the ordinary reconciliation path, which is the
    // honest answer for a file nobody has measured.
    realMetres: usable?.realCm ? usable.realCm / 100 : (plain === base?.plainUrl ? base?.realMetres ?? null : null),
    realAxis: usable?.scaleAxis ?? (plain === base?.plainUrl ? base?.realAxis : undefined) ?? 'height',
  }
}

/**
 * The client only ever needs the fetch url and the fix-ups. Stripping this down
 * before it crosses to the browser keeps storage keys and provider names on the
 * server, where p3d keeps them too.
 */
export type ClientModel = {
  productId: string
  /** The add-on combination this entry draws; '' for the base model. */
  context: string
  url: string
  cacheKey: string
  format: ResolvedModel['format']
  yawOffsetDeg: number
  noDecimation: boolean
  fabricKey: string
  slots: FabricSlot[]
  realMetres: number | null
  realAxis: 'height' | 'width'
}

export function toClientModels(models: Map<string, PlannerModel>): ClientModel[] {
  return [...models.values()].map((model) => ({
    productId: model.productId,
    context: model.context,
    url: model.fetchUrl,
    cacheKey: model.plainUrl,
    format: model.format,
    yawOffsetDeg: model.yawOffsetDeg,
    noDecimation: model.noDecimation,
    fabricKey: model.fabricKey,
    slots: model.slots,
    realMetres: model.realMetres,
    realAxis: model.realAxis,
  }))
}
