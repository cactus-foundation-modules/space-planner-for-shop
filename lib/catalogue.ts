import { getShopConfigCached } from '@/modules/shop/lib/config'
import { formatMoney } from '@/modules/shop/lib/money'
import { effectivePrice } from '@/modules/shop/lib/pricing'
import { makeDisplayAdjuster, resolveTaxDisplay } from '@/modules/shop/lib/tax-display'
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

export async function browseCatalogue(filter: Omit<ListProductsFilter, 'status' | 'excludeHidden'>): Promise<CatalogueBrowse> {
  const perPage = Math.min(48, Math.max(1, Math.floor(Number(filter.perPage)) || 24))
  const page = Math.max(1, Math.floor(Number(filter.page)) || 1)

  const [{ products, total }, shopConfig, taxDisplay] = await Promise.all([
    listProducts({ ...filter, page, perPage, status: 'ACTIVE', excludeHidden: true }),
    getShopConfigCached(),
    resolveTaxDisplay(),
  ])

  const ids = products.map((p) => p.id)
  const [images, models, children, specValues, dimensions] = await Promise.all([
    getPrimaryProductImages(ids),
    getModelsForProducts(ids),
    getVariationChildrenForProducts(ids),
    getSpecValues(ids),
    resolveDimensions(ids),
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
    const net = effectivePrice(product, shopConfig.enabledPriceTypes)
    const price = adjust ? adjust(net) : net
    const stock = stockState(product)
    const size = dimensions.get(product.id)
    const kids = children.get(product.id) ?? []

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      sku: product.sku ?? '',
      price,
      priceFormatted: formatMoney(price, shopConfig.currencySymbol),
      image: images[product.id] ?? null,
      hasModel: modelled.has(product.id) || kids.some((childId) => modelledChildren.has(childId)),
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

/** The category list the panel filters by, flat and cheap. */
export async function listPlannerCategories(): Promise<Array<{ id: string; name: string; slug: string }>> {
  const categories = await listCategories()
  return categories.map((category) => ({ id: category.id, name: category.name, slug: category.slug }))
}
