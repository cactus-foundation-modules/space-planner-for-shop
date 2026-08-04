import { NextRequest, NextResponse } from 'next/server'
import { shopClosedResponse } from '@/modules/shop/lib/access'
import { browseCatalogue, listPlannerCategories } from '@/modules/space-planner-for-shop/lib/catalogue'
import { plannerHiddenResponse } from '@/modules/space-planner-for-shop/lib/visibility'

// The browse panel's data.
//
// PUBLIC, because a signed-out visitor gets the whole tool and only the saving
// needs an account. It shows exactly what the storefront shows - shop's own
// listProducts does the filtering, so a draft product or a catalogue-hidden
// variant child cannot leak out through a side door the shop does not know
// about.
export async function GET(request: NextRequest) {
  const closed = await shopClosedResponse()
  if (closed) return closed
  const hidden = await plannerHiddenResponse()
  if (hidden) return hidden

  const params = request.nextUrl.searchParams
  const page = Number(params.get('page') ?? '1')
  const perPage = Number(params.get('perPage') ?? '24')
  const search = params.get('search') ?? undefined
  const categorySlug = params.get('category') ?? undefined
  const stock = params.get('stock')

  const result = await browseCatalogue({
    page,
    perPage,
    search,
    categorySlug,
    stock: stock === 'in' || stock === 'low' || stock === 'out' ? stock : undefined,
    sort: 'name-asc',
  })

  return NextResponse.json({
    ...result,
    categories: params.get('withCategories') === '1' ? await listPlannerCategories() : undefined,
  })
}
