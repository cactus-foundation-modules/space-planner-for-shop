import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { shopClosedResponse } from '@/modules/shop/lib/access'
import { resolveCardFromPrices } from '@/modules/shop/lib/card-price'
import { getPrimaryProductImages, getProductsByIds } from '@/modules/shop/lib/db/products'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { effectivePrice } from '@/modules/shop/lib/pricing'
import { formatMoney } from '@/modules/shop/lib/money'
import { makeDisplayAdjuster, resolveTaxDisplay } from '@/modules/shop/lib/tax-display'
import { resolveDimensions } from '@/modules/space-planner-for-shop/lib/resolve-dimensions'
import { resolveModelsForProducts, toClientModels } from '@/modules/space-planner-for-shop/lib/model-resolver'

// Everything the planner needs to put a specific set of products in a room:
// sizes off the ladder, a freshly signed model url where there is a model, the
// price the storefront would print, and the clearance measurements the
// under-desk fit check uses.
//
// POST rather than GET because a plan can reference a couple of hundred product
// ids and a query string is not the place for them. Nothing is written.

const Body = z.object({ productIds: z.array(z.string().min(1).max(64)).min(1).max(400) })

export async function POST(request: NextRequest) {
  const closed = await shopClosedResponse()
  if (closed) return closed

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Bad request' }, { status: 400 })

  const ids = [...new Set(parsed.data.productIds)]
  const [products, images, dimensions, models, shopConfig, taxDisplay, fromPrices] = await Promise.all([
    getProductsByIds(ids),
    getPrimaryProductImages(ids),
    resolveDimensions(ids),
    resolveModelsForProducts(ids),
    getShopConfigCached(),
    resolveTaxDisplay(),
    // A listing priced through its variations has no price of its own. Without
    // this the item list totals a room full of furniture at nothing.
    resolveCardFromPrices(ids),
  ])

  const items = ids
    .map((id) => {
      const product = products.get(id)
      if (!product) return null
      // Only what the storefront would show. `getProductsByIds` is a plain
      // fetch by id, so without this an unauthenticated caller could read the
      // name and the price of a DRAFT or ARCHIVED product by guessing at ids -
      // a small leak, but a leak out of a shop's unreleased pricing.
      //
      // Filtered on status ALONE, deliberately. `catalogue_hidden` is what
      // marks a variation child, and variation children are precisely what this
      // route exists to size: the planner browses at listing level and places
      // at variant level, exactly as the cart does.
      if (product.status !== 'ACTIVE') return null
      const size = dimensions.get(id)
      const adjust = makeDisplayAdjuster(taxDisplay, product.taxClassId)
      const from = fromPrices.get(id)
      const net = from ? Number(from.price) : effectivePrice(product, shopConfig.enabledPriceTypes)
      const price = adjust ? adjust(net) : net
      return {
        id,
        name: product.name,
        sku: product.sku ?? '',
        slug: product.slug,
        image: images[id] ?? null,
        price,
        priceFormatted: `${from?.varies ? 'From ' : ''}${formatMoney(price, shopConfig.currencySymbol)}`,
        widthMm: size?.widthMm ?? 800,
        depthMm: size?.depthMm ?? 600,
        heightMm: size?.heightMm ?? 750,
        sizeSource: size?.source ?? 'marker',
        mount: size?.mountType ?? 'floor',
        underTopHeightMm: size?.underTop.heightMm ?? null,
        underTopWidthMm: size?.underTop.widthMm ?? null,
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)

  return NextResponse.json({ items, models: toClientModels(models) })
}
