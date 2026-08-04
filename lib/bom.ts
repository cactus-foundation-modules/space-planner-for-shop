import { getProductsByIds } from '@/modules/shop/lib/db/products'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { formatMoney } from '@/modules/shop/lib/money'
import { effectivePrice } from '@/modules/shop/lib/pricing'
import { makeDisplayAdjuster, resolveTaxDisplay } from '@/modules/shop/lib/tax-display'
import type { PlanItems, ProductSnapshot } from '@/modules/space-planner-for-shop/lib/types'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'

// The item list - the thing a buyer actually takes away.
//
// Prices come out of the shop's own resolution and tax-display utilities in the
// shop's own order, so the planner can never disagree with the storefront about
// what something costs. It is list prices only: promotions and discounts resolve
// at checkout, and the footer says so rather than leaving somebody to discover
// it.
//
// It doubles as the accessible representation of the scene. Everything placed in
// the room appears here, enumerated, with its size - so the 3D canvas is never
// the only way to know what is in the plan.

export type BomLine = {
  productId: string
  name: string
  sku: string
  slug: string
  quantity: number
  /** Display price for one, already tax-adjusted the way the storefront shows it. */
  unitPrice: number
  unitPriceFormatted: string
  lineTotal: number
  lineTotalFormatted: string
  sizeLabel: string
  approximate: boolean
  /** True when the product has gone from the catalogue and this row came off the snapshot. */
  fromSnapshot: boolean
  image: string | null
}

export type Bom = {
  lines: BomLine[]
  itemCount: number
  total: number
  totalFormatted: string
  currencySymbol: string
  taxSuffix: string
  disclaimer: string
  /** Products in the plan that no longer exist, named so the banner can list them. */
  missing: string[]
}

/**
 * Build the item list for a plan.
 *
 * N placed instances of one variant collapse into one line of quantity N, which
 * is both how a buyer thinks about it and what makes "add the whole plan to the
 * cart" fit inside shop's two-hundred-line cart cap without anybody noticing
 * there was a cap.
 */
export async function buildBom(plan: PlanItems, snapshot: ProductSnapshot): Promise<Bom> {
  const counts = new Map<string, number>()
  const sizes = new Map<string, { widthMm: number; depthMm: number; heightMm: number; approximate: boolean }>()

  for (const item of plan.items) {
    if (item.staged) continue
    counts.set(item.productId, (counts.get(item.productId) ?? 0) + 1)
    if (!sizes.has(item.productId)) {
      sizes.set(item.productId, {
        widthMm: item.widthMm,
        depthMm: item.depthMm,
        heightMm: item.heightMm,
        approximate: item.sizeSource === 'category_default' || item.sizeSource === 'marker',
      })
    }
  }

  const productIds = [...counts.keys()]
  const [products, shopConfig, taxDisplay, splConfig] = await Promise.all([
    getProductsByIds(productIds),
    getShopConfigCached(),
    resolveTaxDisplay(),
    getSplConfigCached(),
  ])

  const symbol = shopConfig.currencySymbol
  const lines: BomLine[] = []
  const missing: string[] = []
  let total = 0

  for (const productId of productIds) {
    const quantity = counts.get(productId) ?? 0
    const product = products.get(productId)
    const saved = snapshot[productId]
    const size = sizes.get(productId)

    let name: string
    let sku: string
    let slug: string
    let netPrice: number
    let taxClassId: string | null
    let image: string | null
    let fromSnapshot = false

    if (product) {
      name = product.name
      sku = product.sku ?? ''
      slug = product.slug
      netPrice = effectivePrice(product, shopConfig.enabledPriceTypes)
      taxClassId = product.taxClassId
      image = saved?.image ?? null
    } else if (saved) {
      // The product has gone. The plan still knows what it was, which is the
      // entire reason the snapshot exists.
      name = saved.name
      sku = saved.sku
      slug = saved.slug
      netPrice = saved.price
      taxClassId = saved.taxClassId
      image = saved.image
      fromSnapshot = true
      missing.push(saved.name)
    } else {
      continue
    }

    const adjust = makeDisplayAdjuster(taxDisplay, taxClassId)
    const unitPrice = adjust ? adjust(netPrice) : netPrice
    const lineTotal = unitPrice * quantity
    total += lineTotal

    lines.push({
      productId,
      name,
      sku,
      slug,
      quantity,
      unitPrice,
      unitPriceFormatted: formatMoney(unitPrice, symbol),
      lineTotal,
      lineTotalFormatted: formatMoney(lineTotal, symbol),
      sizeLabel: size ? `${Math.round(size.widthMm)} × ${Math.round(size.depthMm)} × ${Math.round(size.heightMm)} mm` : '',
      approximate: size?.approximate ?? false,
      fromSnapshot,
      image,
    })
  }

  lines.sort((a, b) => a.name.localeCompare(b.name))

  return {
    lines,
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    total,
    totalFormatted: formatMoney(total, symbol),
    currencySymbol: symbol,
    taxSuffix: taxDisplay.display.suffix,
    disclaimer: splConfig.bomDisclaimer,
    missing,
  }
}

/**
 * The plan as cart lines: one line per variant, quantity N.
 *
 * The caller writes these through shop's own cart utility and never through
 * localStorage directly - a direct write works on the day and silently loses the
 * cross-device sync a signed-in member's basket now has, which is exactly the
 * kind of defect that surfaces as "the planner lost my basket" a fortnight later.
 */
export function planToCartLines(plan: PlanItems): Array<{ productId: string; quantity: number }> {
  const counts = new Map<string, number>()
  for (const item of plan.items) {
    if (item.staged) continue
    counts.set(item.productId, (counts.get(item.productId) ?? 0) + 1)
  }
  return [...counts.entries()].map(([productId, quantity]) => ({ productId, quantity }))
}

/** shop's own server-side cap on a member cart. Checked before writing, not after a 400. */
export const MEMBER_CART_MAX_LINES = 200
