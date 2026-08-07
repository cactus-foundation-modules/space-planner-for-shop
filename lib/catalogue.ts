import { getShopConfigCached } from '@/modules/shop/lib/config'
import { formatMoney } from '@/modules/shop/lib/money'
import { effectivePrice } from '@/modules/shop/lib/pricing'
import { makeDisplayAdjuster, resolveTaxDisplay } from '@/modules/shop/lib/tax-display'
import { resolveCardFromPrices } from '@/modules/shop/lib/card-price'
import { getPrimaryProductImages, listProducts } from '@/modules/shop/lib/db/products'
import type { ListProductsFilter } from '@/modules/shop/lib/db/products'
import type { ShpProduct } from '@/modules/shop/lib/types'
import { listCategories } from '@/modules/shop/lib/db/catalogue'
import { getModelsForProducts, getVariationChildrenForProducts } from '@/modules/product-3d-views-for-shop/lib/db/models'
import { getSpecValues, isMadeToOrder } from '@/modules/space-planner-for-shop/lib/spec-attributes'
import { resolveDimensions } from '@/modules/space-planner-for-shop/lib/resolve-dimensions'

// The browse panel's data.
//
// It browses at LISTING level (the 462 visible products, not the twenty-two
// thousand rows) and places at VARIANT level, exactly as the cart does. Shop's
// own listProducts does the filtering, so catalogue-hidden rows and draft
// products are excluded on the storefront's terms rather than on ours.

export type CatalogueCard = {
  id: string
  name: string
  slug: string
  sku: string
  price: number
  priceFormatted: string
  image: string | null
  /**
   * Whether this listing has a real 3D model behind it anywhere.
   *
   * With roughly nineteen listings in twenty carrying no model at all, this is
   * the difference between a browse panel and a lucky dip. It is answered with
   * two set-wide queries rather than per product - the batched primitives exist
   * precisely for this, and the tempting alternative (p3d's card-media provider)
   * awaits two config lookups inside a per-product loop, which is fine for a
   * grid of twelve cards and hopeless for a panel paging a catalogue.
   */
  hasModel: boolean
  /**
   * Whether this listing is really a family, and so has to be chosen from before
   * it can be placed.
   *
   * A listing's own size row is the family's, not any one member's: the Oslo Oval
   * Boardroom Table listing states a depth and a height and no width at all, so
   * the ladder fills the width from the category default and the room gets a
   * 2.4 m table in an 800 mm footprint. The member carries the real numbers, and
   * the panel now asks which member before it places anything.
   *
   * Free to answer - the children were already fetched for `hasModel`.
   */
  hasVariations: boolean
  inStock: boolean
  stockLabel: string
  madeToOrder: boolean
  widthMm: number
  depthMm: number
  heightMm: number
  approximateSize: boolean
}

export type CatalogueBrowse = {
  cards: CatalogueCard[]
  total: number
  page: number
  perPage: number
  taxSuffix: string
}

function stockState(product: ShpProduct): { inStock: boolean; label: string } {
  if (product.isPreOrder) return { inStock: true, label: 'Pre-order' }
  if (!product.trackInventory) return { inStock: true, label: '' }
  const count = product.stockCount ?? 0
  if (count > 0) return { inStock: true, label: count <= (product.lowStockThreshold ?? 0) ? 'Low stock' : '' }
  return {
    inStock: product.outOfStockBehaviour === 'BACKORDER',
    label: product.outOfStockBehaviour === 'BACKORDER' ? 'On backorder' : 'Out of stock',
  }
}

export async function browseCatalogue(
  filter: Omit<ListProductsFilter, 'status' | 'excludeHidden'> & { modelledOnly?: boolean },
): Promise<CatalogueBrowse> {
  const perPage = Math.min(48, Math.max(1, Math.floor(Number(filter.perPage)) || 24))
  const page = Math.max(1, Math.floor(Number(filter.page)) || 1)

  const [shopConfig, taxDisplay] = await Promise.all([getShopConfigCached(), resolveTaxDisplay()])

  let products: ShpProduct[]
  let total: number

  if (filter.modelledOnly) {
    // The filter has to run server-side or the page numbers lie: with nineteen
    // listings in twenty unmodelled, filtering a fetched page client-side shows
    // one or two cards while "More" promises hundreds. The listing count is a
    // few hundred, so sweeping them through shop's own filter (which is what
    // keeps drafts and hidden children out) and keeping the modelled ones is
    // cheap - and capped, so a pathological catalogue degrades rather than hangs.
    const all: ShpProduct[] = []
    const scanPer = 100
    for (let scanPage = 1; scanPage <= 25; scanPage += 1) {
      const batch = await listProducts({ ...filter, page: scanPage, perPage: scanPer, status: 'ACTIVE', excludeHidden: true })
      all.push(...batch.products)
      if (all.length >= batch.total || batch.products.length < scanPer) break
    }
    const allIds = all.map((p) => p.id)
    const allChildren = await getVariationChildrenForProducts(allIds)
    const allChildIds: string[] = []
    for (const list of allChildren.values()) allChildIds.push(...list)
    const allModels = await getModelsForProducts([...allIds, ...allChildIds])
    const modelledSet = new Set(allModels.map((model) => model.productId))
    const matching = all.filter(
      (p) => modelledSet.has(p.id) || (allChildren.get(p.id) ?? []).some((childId) => modelledSet.has(childId)),
    )
    total = matching.length
    products = matching.slice((page - 1) * perPage, page * perPage)
  } else {
    const result = await listProducts({ ...filter, page, perPage, status: 'ACTIVE', excludeHidden: true })
    products = result.products
    total = result.total
  }

  const ids = products.map((p) => p.id)
  const [images, models, children, specValues, dimensions, fromPrices] = await Promise.all([
    getPrimaryProductImages(ids),
    getModelsForProducts(ids),
    getVariationChildrenForProducts(ids),
    getSpecValues(ids),
    resolveDimensions(ids),
    // A listing whose price lives on its variations has a price of zero of its
    // own, and printing that is worse than printing nothing: a browse panel full
    // of "£0.00" reads as a broken shop. This is the same resolver every product
    // grid on the site uses, so the planner can never disagree with the shop
    // about what a thing costs.
    resolveCardFromPrices(ids),
  ])

  // A listing counts as modelled when it, or any of its variant children, has a
  // model row. Both lookups are set-wide, so this costs two queries for the page
  // rather than two per card.
  const modelled = new Set(models.map((model) => model.productId))
  const childIds: string[] = []
  for (const list of children.values()) childIds.push(...list)
  const childModels = childIds.length ? await getModelsForProducts(childIds) : []
  const modelledChildren = new Set(childModels.map((model) => model.productId))

  const cards: CatalogueCard[] = products.map((product) => {
    const adjust = makeDisplayAdjuster(taxDisplay, product.taxClassId)
    const own = effectivePrice(product, shopConfig.enabledPriceTypes)
    const from = fromPrices.get(product.id)
    // The variation price wins where there is one - it is the only figure that
    // means anything for a listing that is really a family of products. "From"
    // is earned by a genuine range: a family whose every choice costs the same
    // has one price, and prefixing it just makes the shopper hunt for the catch.
    const net = from ? Number(from.price) : own
    const price = adjust ? adjust(net) : net
    const priceFormatted = `${from?.varies ? 'From ' : ''}${formatMoney(price, shopConfig.currencySymbol)}`
    const stock = stockState(product)
    const size = dimensions.get(product.id)
    const kids = children.get(product.id) ?? []

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      sku: product.sku ?? '',
      price,
      priceFormatted,
      image: images[product.id] ?? null,
      hasModel: modelled.has(product.id) || kids.some((childId) => modelledChildren.has(childId)),
      hasVariations: kids.length > 0,
      inStock: stock.inStock,
      stockLabel: stock.label,
      madeToOrder: isMadeToOrder(specValues.get(product.id) ?? []),
      widthMm: size?.widthMm ?? 800,
      depthMm: size?.depthMm ?? 600,
      heightMm: size?.heightMm ?? 750,
      approximateSize: size ? size.source === 'category_default' || size.source === 'marker' : true,
    }
  })

  return { cards, total, page, perPage, taxSuffix: taxDisplay.display.suffix }
}

/** The category list the panel filters by - flat rows, but carrying the parent
 *  so the panel can group leaves under their section instead of presenting
 *  fifty categories as one long unordered list. */
export async function listPlannerCategories(): Promise<Array<{ id: string; name: string; slug: string; parentId: string | null }>> {
  const categories = await listCategories()
  return categories.map((category) => ({ id: category.id, name: category.name, slug: category.slug, parentId: category.parentId }))
}
