import { NextRequest, NextResponse } from 'next/server'
import { requireSplUser } from '@/modules/space-planner-for-shop/lib/access'
import { deletePlanForAdmin, getPlanForAdmin } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForAdmin } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { buildBom } from '@/modules/space-planner-for-shop/lib/bom'

// One customer's plan, read-only, for the person on the telephone.
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireSplUser('space-planner.access', { allowAccess: true })
  if (gate.error) return gate.error
  const { id } = await context.params

  const plan = await getPlanForAdmin(id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const room = await getRoomForAdmin(plan.roomId)
  const bom = await buildBom(plan.items, plan.productSnapshot)

  return NextResponse.json({ plan, room, bom })
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error
  const { id } = await context.params

  const ok = await deletePlanForAdmin(id)
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
