import { NextRequest, NextResponse } from 'next/server'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { getPlanForMember } from '@/modules/space-planner-for-shop/lib/db/plans'
import { buildBom } from '@/modules/space-planner-for-shop/lib/bom'
import { estimateDelivery } from '@/modules/space-planner-for-shop/lib/delivery'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'

// The priced item list for a saved plan.
//
// Server-side because the prices are: the planner can never be allowed to
// disagree with the storefront about what something costs, so the figures come
// out of shop's own price resolution and tax display, in shop's own order.
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const config = await getSplConfigCached()
  const bom = await buildBom(plan.items, plan.productSnapshot)
  const delivery = config.deliveryColumnEnabled ? await estimateDelivery(bom) : null

  return NextResponse.json({ bom, delivery })
}
