import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { shopClosedResponse } from '@/modules/shop/lib/access'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { getProductsByIds } from '@/modules/shop/lib/db/products'
import { getVariantSelectorPayload } from '@/modules/shop-variations/lib/variants-service'
import { getModelsForProducts } from '@/modules/product-3d-views-for-shop/lib/db/models'
import { plannerHiddenResponse } from '@/modules/space-planner-for-shop/lib/visibility'
import { getQuoteConfigCached, pricesHidden } from '@/modules/quote-for-shop/lib/config'

// Which member of a family the shopper is putting in the room.
//
// The panel browses listings, and a listing is not a thing you can place: the
// Oslo Oval Boardroom Table comes in 180 cm and 240 cm, and the LISTING's size
// row states a depth, a height and no width at all - so the ladder fills the
// width from the category default and the room gets a two-and-a-half metre table
// drawn in an 800 mm footprint, priced "from". Every real number lives on the
// variation, so the panel asks which one before it places anything.
//
// The maths behind the picker is shop-variations' own (`lib/selection-logic`),
// and so is this payload - the same one its product-page selector uses, so the
// planner can never offer a combination the shop would not sell. A hard import
// rather than the to_regclass probing `lib/spec-attributes.ts` does, because
// shop-variations is a declared requiredModule of this one and its absence is
// not a case that exists.

const Body = z.object({ productId: z.string().min(1).max(64) })

export async function POST(request: NextRequest) {
  const closed = await shopClosedResponse()
  if (closed) return closed
  const hidden = await plannerHiddenResponse()
  if (hidden) return hidden

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Bad request' }, { status: 400 })

  const productId = parsed.data.productId
  // Same guard as the products route, and for the same reason: this is an
  // unauthenticated endpoint that takes an id, so a DRAFT product's options and
  // unreleased prices must not come back out of it.
  const product = (await getProductsByIds([productId])).get(productId)
  if (!product || product.status !== 'ACTIVE') return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const payload = await getVariantSelectorPayload(productId)
  if (!payload || payload.variants.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Which of the family have a model of their own, so a shopper choosing between
  // finishes can see which choices arrive as furniture and which as a labelled
  // box. One query for the whole matrix.
  const childIds = payload.variants.map((variant) => variant.childProductId)
  const models = await getModelsForProducts(childIds)
  const modelled = [...new Set(models.map((model) => model.productId))]

  const [config, quoteConfig] = await Promise.all([getShopConfigCached(), getQuoteConfigCached()])
  const hidePrices = pricesHidden(quoteConfig)

  // Every per-variant figure zeroed on a shop that has agreed not to show
  // prices. This route asked nothing at all: it returned the product page's own
  // payload, which carries a `price` and a `salePrice` per variant, unchanged
  // and unauthenticated - so the one screen in the module that lists a whole
  // range's prices side by side was also the one that never checked. The
  // picker formats these itself on its fallback path, so masking the string
  // alone would not have been enough.
  const variants = hidePrices
    ? payload.variants.map((variant) => ({ ...variant, price: 0, salePrice: null }))
    : payload.variants

  return NextResponse.json({
    // Trimmed on the way out: the picker paints option controls and nothing
    // else, and a chair range's gallery is a lot of bytes to send to a panel
    // that never shows it. The shape is kept so shop-variations' own selection
    // maths reads it unchanged.
    payload: { ...payload, variants, addons: [], baseImages: [] },
    currencySymbol: config.currencySymbol,
    pricesHidden: hidePrices,
    hiddenPriceLabel: quoteConfig.hiddenPriceLabel,
    modelled,
  })
}
