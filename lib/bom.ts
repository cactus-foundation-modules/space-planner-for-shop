import { getProductsByIds } from '@/modules/shop/lib/db/products'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { formatMoney } from '@/modules/shop/lib/money'
import { effectivePrice } from '@/modules/shop/lib/pricing'
import { makeDisplayAdjuster, resolveTaxDisplay } from '@/modules/shop/lib/tax-display'
import { getQuoteConfigCached, pricesHidden } from '@/modules/quote-for-shop/lib/config'
import type { PlanItems, ProductSnapshot } from '@/modules/space-planner-for-shop/lib/types'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { countPlanProducts } from '@/modules/space-planner-for-shop/lib/plan-counts'

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
  /**
   * Whether this shop shows prices at all.
   *
   * Answered here, once, because every priced surface in the module consumes a
   * Bom: the item list, the PDF, the plan email, the shared page and the quote.
   * Only the PDF and the quote used to ask, so a shop set to quote-only with
   * prices hidden went on publishing its list prices on the share link - a page
   * anybody holding the url can open - and in the emailed plan.
   */
  pricesHidden: boolean
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

  // Counted through the shared rule, so this and the running total the shopper
  // watched while choosing cannot disagree. It includes the companions bought
  // with an item - the screens riding inside a combined desk model - which are
  // drawn in the room and go back to the basket with it, and whose absence
  // priced a desk-with-screens as a bare desk on every document this makes.
  for (const [productId, quantity] of countPlanProducts(plan.items)) counts.set(productId, quantity)

  for (const item of plan.items) {
    if (item.staged) continue
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
  const [products, shopConfig, taxDisplay, splConfig, quoteConfig] = await Promise.all([
    getProductsByIds(productIds),
    getShopConfigCached(),
    resolveTaxDisplay(),
    getSplConfigCached(),
    getQuoteConfigCached(),
  ])

  const symbol = shopConfig.currencySymbol
  // One answer for every surface that prints one of these. Formatted money is
  // replaced with the shop's own wording rather than blanked, so a list still
  // reads as a list; the numbers stay on the object for the quote flow, which
  // needs them to raise the quote itself.
  const hidePrices = pricesHidden(quoteConfig)
  const money = (amount: number): string => (hidePrices ? quoteConfig.hiddenPriceLabel : formatMoney(amount, symbol))
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

    // ACTIVE, not merely present. `getProductsByIds` is a plain fetch by id, so
    // a product the owner has archived or put back to draft still resolves - and
    // this list would then quote its CURRENT, unreleased price for something
    // shop's own checkout refuses to sell. The browser drops non-ACTIVE products
    // already (see the public products route), so without this the same plan
    // priced one way on screen and another on the PDF, the email and the quote.
    // The snapshot branch below is the right answer for exactly this case.
    if (product && product.status === 'ACTIVE') {
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
      // By name rather than by id, and deduplicated: two retired variants of one
      // range share a name, and the banner naming it twice reads as a fault in
      // the banner.
      if (!missing.includes(saved.name)) missing.push(saved.name)
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
      unitPriceFormatted: money(unitPrice),
      lineTotal,
      lineTotalFormatted: money(lineTotal),
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
    totalFormatted: money(total),
    currencySymbol: symbol,
    taxSuffix: taxDisplay.display.suffix,
    disclaimer: splConfig.bomDisclaimer,
    missing,
    pricesHidden: hidePrices,
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
  // Same rule as the item list and the running total: companions bought with an
  // item count too, or a quote asks for the desk without its screens.
  return [...countPlanProducts(plan.items).entries()].map(([productId, quantity]) => ({ productId, quantity }))
}

/** shop's own server-side cap on a member cart. Checked before writing, not after a 400. */
export const MEMBER_CART_MAX_LINES = 200
