import { getPrimaryProductImages, getProductsByIds } from '@/modules/shop/lib/db/products'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { effectivePrice } from '@/modules/shop/lib/pricing'
import type { PlanItems, ProductSnapshot } from '@/modules/space-planner-for-shop/lib/types'

// What a plan remembers about the products in it.
//
// Taken on the server at save time, never trusted from the client - a snapshot
// assembled in the browser is a snapshot the browser can lie about, and this one
// carries prices. It is deliberately not recomputed on read: a plan saved in
// March should still read the way it did in March, with the banner explaining
// what has changed since rather than the numbers quietly moving.

export async function buildProductSnapshot(plan: PlanItems, previous: ProductSnapshot = {}): Promise<ProductSnapshot> {
  const ids = [...new Set(plan.items.map((item) => item.productId))].filter(Boolean)
  if (ids.length === 0) return {}

  const [products, images, shopConfig] = await Promise.all([
    getProductsByIds(ids),
    getPrimaryProductImages(ids),
    getShopConfigCached(),
  ])

  const snapshot: ProductSnapshot = {}
  for (const id of ids) {
    const product = products.get(id)
    if (!product) {
      // Gone from the catalogue. Keep whatever the plan already knew rather than
      // dropping the entry - that copy is the only description of this thing
      // left anywhere, and losing it turns the plan into anonymous boxes.
      const kept = previous[id]
      if (kept) snapshot[id] = kept
      continue
    }
    snapshot[id] = {
      name: product.name,
      sku: product.sku ?? '',
      slug: product.slug,
      price: effectivePrice(product, shopConfig.enabledPriceTypes),
      taxClassId: product.taxClassId,
      image: images[id] ?? previous[id]?.image ?? null,
      parentId: null,
      optionSummary: previous[id]?.optionSummary ?? '',
    }
  }
  return snapshot
}

/** Which products in a plan have gone or changed name since it was saved. */
export async function findSnapshotDrift(snapshot: ProductSnapshot): Promise<{ missing: string[]; renamed: Array<{ was: string; now: string }> }> {
  const ids = Object.keys(snapshot)
  if (ids.length === 0) return { missing: [], renamed: [] }
  const products = await getProductsByIds(ids)

  const missing: string[] = []
  const renamed: Array<{ was: string; now: string }> = []
  for (const id of ids) {
    const saved = snapshot[id]
    if (!saved) continue
    const product = products.get(id)
    if (!product) {
      missing.push(saved.name)
      continue
    }
    if (product.name !== saved.name) renamed.push({ was: saved.name, now: product.name })
  }
  return { missing, renamed }
}
