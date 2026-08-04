import { NextRequest, NextResponse } from 'next/server'
import { recordMemberActivity } from '@/lib/members/activity'
import { itemQuotaExceeded, planQuotaExceeded, requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { createPlan, listPlansForRoom } from '@/modules/space-planner-for-shop/lib/db/plans'
import { PlanWriteSchema, payloadTooLarge } from '@/modules/space-planner-for-shop/lib/validation'
import { buildProductSnapshot } from '@/modules/space-planner-for-shop/lib/snapshot'
import { recordEvent, recordEvents } from '@/modules/space-planner-for-shop/lib/db/events'
import type { PlanItems } from '@/modules/space-planner-for-shop/lib/types'

// The plans inside one room. GET lists them; POST adds one.
//
// Ownership is proved on the ROOM first - a plan id is not a capability, and
// neither is a room id, so the room is fetched by (id, memberId) before anything
// is written under it.

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const room = await getRoomForMember(id, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const plans = await listPlansForRoom(id, gate.member.id)
  return NextResponse.json({ plans })
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const room = await getRoomForMember(id, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const raw = await request.text()
  if (payloadTooLarge(raw)) {
    return NextResponse.json({ error: 'That plan is bigger than we can store.' }, { status: 413 })
  }
  const parsed = PlanWriteSchema.safeParse(safeJson(raw))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error?.issues[0]?.message ?? 'That plan did not look right.' }, { status: 400 })
  }

  const quota = await planQuotaExceeded(id)
  if (quota) return NextResponse.json({ error: quota }, { status: 409 })

  const items = parsed.data.items as PlanItems
  const itemQuota = await itemQuotaExceeded(items.items.length)
  if (itemQuota) return NextResponse.json({ error: itemQuota }, { status: 409 })

  // The snapshot is taken here, on the server, from the live catalogue - never
  // accepted from the browser. It carries prices, and a price the client can
  // choose is not a price.
  const snapshot = await buildProductSnapshot(items)

  const plan = await createPlan({
    roomId: id,
    memberId: gate.member.id,
    name: parsed.data.name,
    items,
    productSnapshot: snapshot,
  })

  await recordEvent('plan.saved', { planId: plan.id })
  await recordEvents(
    [...new Set(items.items.filter((item) => !item.staged).map((item) => item.productId))].map((productId) => ({
      event: 'item.placed' as const,
      planId: plan.id,
      productId,
    })),
  )
  await recordMemberActivity(gate.member.id, 'space-planner.plan-saved', { source: 'space-planner-for-shop', metadata: { planId: plan.id } }).catch(() => {})

  return NextResponse.json({ plan })
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
