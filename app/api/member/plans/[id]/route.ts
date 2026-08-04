import { NextRequest, NextResponse } from 'next/server'
import { itemQuotaExceeded, requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { archivePlanVersion, deletePlan, getPlanForMember, updatePlan } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { PlanWriteSchema, payloadTooLarge } from '@/modules/space-planner-for-shop/lib/validation'
import { buildProductSnapshot, findSnapshotDrift } from '@/modules/space-planner-for-shop/lib/snapshot'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { recordEvent } from '@/modules/space-planner-for-shop/lib/db/events'
import type { PlanItems } from '@/modules/space-planner-for-shop/lib/types'

// One plan: read it, save over it, delete it.
//
// A save archives the previous state first (capped, and a member-labelled
// version is never swept), which is what makes "I dragged something and did not
// notice" recoverable after the tab has been closed. Undo only lasts as long as
// the session; a saved plan is a document.
//
// GET also reports drift: which products in the plan have gone or been renamed
// since it was saved. The plan itself renders from its snapshot regardless - the
// banner explains, it does not repair.

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const room = await getRoomForMember(plan.roomId, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const drift = await findSnapshotDrift(plan.productSnapshot)
  return NextResponse.json({ plan, room, drift })
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const raw = await request.text()
  if (payloadTooLarge(raw)) {
    return NextResponse.json({ error: 'That plan is bigger than we can store.' }, { status: 413 })
  }
  const parsed = PlanWriteSchema.partial({ productSnapshot: true }).safeParse(safeJson(raw))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error?.issues[0]?.message ?? 'That plan did not look right.' }, { status: 400 })
  }

  const existing = await getPlanForMember(id, gate.member.id)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const items = parsed.data.items as PlanItems
  const quota = await itemQuotaExceeded(items.items.length)
  if (quota) return NextResponse.json({ error: quota }, { status: 409 })

  const config = await getSplConfigCached()
  await archivePlanVersion(existing, config.maxVersionsPerPlan)

  const snapshot = await buildProductSnapshot(items, existing.productSnapshot)
  const plan = await updatePlan(id, gate.member.id, {
    name: parsed.data.name,
    items,
    productSnapshot: snapshot,
  })
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await recordEvent('plan.saved', { planId: plan.id })
  return NextResponse.json({ plan })
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const ok = await deletePlan(id, gate.member.id)
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
