import { signAssetUrl } from '@/lib/media/asset-token'
import { getModelsForProducts } from '@/modules/product-3d-views-for-shop/lib/db/models'
import { getModelMetaForModels, getModelMetaForProducts } from '@/modules/space-planner-for-shop/lib/db/model-meta'
import { plainUrl } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { ResolvedModel } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { MountType } from '@/modules/space-planner-for-shop/lib/types'

// Which file draws which product, and the fix-ups that go with it.
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

export type PlannerModel = ResolvedModel & {
  /** Freshly signed, for this response only. Never persisted, never a cache key. */
  fetchUrl: string
  mountOverride: MountType | null
}

export async function resolveModelsForProducts(productIds: string[]): Promise<Map<string, PlannerModel>> {
  const out = new Map<string, PlannerModel>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return out

  const models = await getModelsForProducts(ids)
  if (models.length === 0) return out

  const [fileMeta, productMeta] = await Promise.all([
    getModelMetaForModels(models.map((model) => model.id)),
    getModelMetaForProducts(ids),
  ])

  // One model per product: the first by position, which is p3d's own ordering
  // and therefore the one the product page shows first. A planner placing the
  // second-choice model would be a puzzle nobody could debug from the outside.
  const seen = new Set<string>()
  for (const model of models) {
    if (seen.has(model.productId)) continue
    seen.add(model.productId)

    const file = fileMeta.get(model.id)
    const product = productMeta.get(model.productId)
    const plain = plainUrl(model.url)

    out.set(model.productId, {
      productId: model.productId,
      plainUrl: plain,
      fetchUrl: signAssetUrl(plain),
      format: model.format as ResolvedModel['format'],
      yawOffsetDeg: file?.yawOffsetDegrees ?? 0,
      noDecimation: file?.noDecimation ?? false,
      mountOverride: product?.mountType ?? null,
    })
  }

  return out
}

/**
 * The client only ever needs the fetch url and the fix-ups. Stripping this down
 * before it crosses to the browser keeps storage keys and provider names on the
 * server, where p3d keeps them too.
 */
export type ClientModel = {
  productId: string
  url: string
  cacheKey: string
  format: ResolvedModel['format']
  yawOffsetDeg: number
  noDecimation: boolean
}

export function toClientModels(models: Map<string, PlannerModel>): ClientModel[] {
  return [...models.values()].map((model) => ({
    productId: model.productId,
    url: model.fetchUrl,
    cacheKey: model.plainUrl,
    format: model.format,
    yawOffsetDeg: model.yawOffsetDeg,
    noDecimation: model.noDecimation,
  }))
}
