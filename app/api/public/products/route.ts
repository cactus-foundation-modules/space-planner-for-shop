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
import { getVariationParents } from '@/modules/space-planner-for-shop/lib/spec-attributes'
import { plannerHiddenResponse } from '@/modules/space-planner-for-shop/lib/visibility'
import { getQuoteConfigCached, pricesHidden } from '@/modules/quote-for-shop/lib/config'

// Everything the planner needs to put a specific set of products in a room:
// sizes off the ladder, a freshly signed model url where there is a model, the
// price the storefront would print, and the clearance measurements the
// under-desk fit check uses.
//
// POST rather than GET because a plan can reference a couple of hundred product
// ids and a query string is not the place for them. Nothing is written.

const Body = z.object({
  productIds: z.array(z.string().min(1).max(64)).min(1).max(400),
  // Add-on combinations to resolve beside the base models (a desk staged from
  // the basket with its screens). Optional and capped: one per grouped line,
  // not one per product.
  contexts: z
    .array(z.object({
      productId: z.string().min(1).max(64),
      context: z.string().min(1).max(120),
      extraValueIds: z.array(z.string().max(64)).max(40).default([]),
    }))
    .max(80)
    .optional(),
})

export async function POST(request: NextRequest) {
  const closed = await shopClosedResponse()
  if (closed) return closed
  const hidden = await plannerHiddenResponse()
  if (hidden) return hidden

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Bad request' }, { status: 400 })

  const ids = [...new Set(parsed.data.productIds)]
  const [products, images, dimensions, models, shopConfig, taxDisplay, fromPrices, parentOf, quoteConfig] = await Promise.all([
    getProductsByIds(ids),
    getPrimaryProductImages(ids),
    resolveDimensions(ids),
    resolveModelsForProducts(ids, { contexts: parsed.data.contexts }),
    getShopConfigCached(),
    resolveTaxDisplay(),
    // A listing priced through its variations has no price of its own. Without
    // this the item list totals a room full of furniture at nothing.
    resolveCardFromPrices(ids),
    // The listing behind a variant child, so the panel can say "2 in the room"
    // on the family card the shopper actually browses by.
    getVariationParents(ids),
    // Whether this shop shows prices at all. A PUBLIC route, so getting this
    // wrong hands a quote-only shop's list prices to anybody who asks - and the
    // planner's own item list and running total are built from what this
    // returns, which is why they went on printing money while the PDF, the
    // email and the share page all said "price on application".
    getQuoteConfigCached(),
  ])

  const hidePrices = pricesHidden(quoteConfig)

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
        parentId: parentOf.get(id) ?? null,
        // Zero where the shop hides its prices, so nothing downstream can add a
        // figure up: the planner's running total and item list are computed in
        // the browser from exactly this, and would otherwise print money the
        // rest of the module has agreed not to show.
        price: hidePrices ? 0 : price,
        priceFormatted: hidePrices
          ? quoteConfig.hiddenPriceLabel
          : `${from?.varies ? 'From ' : ''}${formatMoney(price, shopConfig.currencySymbol)}`,
        // Said as a flag as well as in the wording, so the item list can decline
        // to multiply a "from" into a definite line total.
        priceVaries: !hidePrices && Boolean(from?.varies),
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

  // The models get the same status filter the items above get, and for exactly
  // the same reason. Without it the status check was decorative: a guessed id
  // for a DRAFT product was refused a name and a price and then handed a freshly
  // signed url to its geometry, its fabrics and its real dimensions - which is
  // rather more of an unreleased product than its name would have been.
  const allowed = new Set(items.map((item) => item.id))
  const visibleModels = toClientModels(models).filter((model) => allowed.has(model.productId))

  return NextResponse.json({ items, models: visibleModels })
}
