import { NextRequest, NextResponse } from 'next/server'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { getPlanForMember, setPlanShare } from '@/modules/space-planner-for-shop/lib/db/plans'
import { recordEvent } from '@/modules/space-planner-for-shop/lib/db/events'

// Share a plan, or stop sharing it.
//
// The token is minted on demand and cleared on revoke, so a plan nobody has
// shared has no token to leak and a revoked link stops working immediately
// rather than eventually.

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const token = plan.shareToken ?? (await setPlanShare(id, gate.member.id, true))
  if (!token) return NextResponse.json({ error: 'Could not share that layout.' }, { status: 500 })

  await recordEvent('plan.shared', { planId: id })
  return NextResponse.json({ token, url: `/space-planner/shared/${token}` })
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await setPlanShare(id, gate.member.id, false)
  return NextResponse.json({ ok: true })
}
