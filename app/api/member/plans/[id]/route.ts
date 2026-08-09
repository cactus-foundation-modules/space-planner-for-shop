import { NextRequest, NextResponse } from 'next/server'
import { itemQuotaExceeded, requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { archivePlanVersion, deletePlan, getPlanForMember, updatePlan } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { PlanWriteSchema, payloadTooLarge } from '@/modules/space-planner-for-shop/lib/validation'
import { buildProductSnapshot, findSnapshotDrift } from '@/modules/space-planner-for-shop/lib/snapshot'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { recordEvent, recordEvents } from '@/modules/space-planner-for-shop/lib/db/events'
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
  const quota = await itemQuotaExceeded(items.items)
  if (quota) return NextResponse.json({ error: quota }, { status: 409 })

  // A save that changes nothing is not a version. Three things in the planner
  // save quietly on their way somewhere else - keeping a viewpoint, exporting a
  // PDF, asking for a photograph - so twenty presses of Export PDF used to
  // evict every real version and leave twenty identical copies of the current
  // layout. The history exists for "I dragged something and did not notice",
  // and it could be emptied without dragging anything.
  //
  // It also stops the plan's updated_at moving, which is what decides whether a
  // finished photograph is labelled as showing the room "as it was" - exporting
  // a PDF while one rendered made the picture arrive stale, and said so in the
  // email, having moved nothing.
  const unchanged = sameItems(existing.items, items) && (parsed.data.name ?? existing.name) === existing.name
  if (unchanged) return NextResponse.json({ plan: existing })

  const config = await getSplConfigCached()
  await archivePlanVersion(existing, config.maxVersionsPerPlan)

  const snapshot = await buildProductSnapshot(items, existing.productSnapshot)
  const plan = await updatePlan(id, gate.member.id, {
    name: parsed.data.name,
    items,
    productSnapshot: snapshot,
  })
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await recordEvent('plan.saved', { planId: plan.id, memberId: gate.member.id })

  // Furniture added to a plan that already existed.
  //
  // 'item.placed' was recorded only when a plan was FIRST created, so everything
  // added afterwards counted for nothing - and those counts are two of the
  // module's most useful outputs: "worth getting modelled" on the Plans screen
  // and the whole worst-first ordering of the Model corrections screen. A shop
  // reading that list was being told which products to model on the strength of
  // first drafts alone.
  //
  // Only products that were not already placed in this plan, so an ordinary
  // save does not re-count what was there before and a plan saved forty times
  // does not outvote forty different plans.
  const wasPlaced = new Set(existing.items.items.filter((item) => !item.staged).map((item) => item.productId))
  const added = [...new Set(items.items.filter((item) => !item.staged).map((item) => item.productId))].filter(
    (productId) => !wasPlaced.has(productId),
  )
  if (added.length > 0) {
    await recordEvents(added.map((productId) => ({ event: 'item.placed' as const, planId: plan.id, productId })))
  }

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

/**
 * Whether two sets of plan items say the same thing.
 *
 * Key order has to be normalised first, and only ONE part of an item needs it:
 * the opaque `meta` bags on `basketLine` and `basketBundle`, which the schema
 * takes as `z.record` and therefore hands through in whatever order it received.
 * The stored copy came back through jsonb, which canonicalises keys by length
 * then bytes, while the incoming copy is in the browser's order - so a plan
 * staged from the basket compared unequal to itself, and the guard above never
 * fired for the module's primary way in.
 */
function sameItems(a: PlanItems, b: PlanItems): boolean {
  return JSON.stringify(canonicalise(a)) === JSON.stringify(canonicalise(b))
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonicalise(source[key])]))
  }
  return value
}
