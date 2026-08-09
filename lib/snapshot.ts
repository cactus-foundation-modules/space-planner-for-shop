import { getPrimaryProductImages, getProductsByIds } from '@/modules/shop/lib/db/products'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { effectivePrice } from '@/modules/shop/lib/pricing'
import { planProductIds } from '@/modules/space-planner-for-shop/lib/plan-counts'
import type { PlanItems, ProductSnapshot } from '@/modules/space-planner-for-shop/lib/types'

// What a plan remembers about the products in it.
//
// Taken on the server at save time, never trusted from the client - a snapshot
// assembled in the browser is a snapshot the browser can lie about, and this one
// carries prices. It is deliberately not recomputed on read: a plan saved in
// March should still read the way it did in March, with the banner explaining
// what has changed since rather than the numbers quietly moving.

export async function buildProductSnapshot(plan: PlanItems, previous: ProductSnapshot = {}): Promise<ProductSnapshot> {
  // Through planProductIds, so the companions bought with an item are recorded
  // too. The item list prices them; taking the snapshot from `item.productId`
  // alone meant that once a screen bought with a desk left the catalogue it
  // vanished from the list, from the total AND from the "no longer in the shop"
  // banner - which is precisely the disappearance this snapshot exists to stop.
  const ids = planProductIds(plan.items).filter(Boolean)
  if (ids.length === 0) return {}

  const [products, images, shopConfig] = await Promise.all([
    getProductsByIds(ids),
    getPrimaryProductImages(ids),
    getShopConfigCached(),
  ])

  const snapshot: ProductSnapshot = {}
  for (const id of ids) {
    const product = products.get(id)
    // Deleted OR withdrawn - the same thing from a plan's point of view, and
    // the same treatment.
    //
    // `getProductsByIds` is a plain fetch by id and does not filter on status,
    // so an archived product still came back here and had its entry rewritten
    // with whatever the owner had since done to it. That defeats buildBom's
    // rule about pricing a withdrawn product from the snapshot: archive
    // something at £100 and re-price it to £250 for next season, and the next
    // time the shopper moved anything and saved, their PDF, their emailed plan
    // and the share link all quoted £250 under a line labelled "no longer
    // sold". The drift banner named it by its new name too - a product they had
    // never seen, reported as discontinued.
    if (!product || product.status !== 'ACTIVE') {
      // Keep whatever the plan already knew rather than dropping the entry -
      // that copy is the only description of this thing left anywhere, and
      // losing it turns the plan into anonymous boxes.
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
    // Archived counts as gone, exactly as it does in buildBom. A product the
    // shop will not sell is one the shopper needs naming in the "no longer in
    // the shop" line, and testing only for the row's existence left it absent
    // from that banner while still being priced from the snapshot.
    if (!product || product.status !== 'ACTIVE') {
      missing.push(saved.name)
      continue
    }
    if (product.name !== saved.name) renamed.push({ was: saved.name, now: product.name })
  }
  return { missing, renamed }
}
