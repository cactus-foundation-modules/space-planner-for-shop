import { NextRequest, NextResponse } from 'next/server'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { deleteRoom, getRoomForMember, updateRoom } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { archivePlanVersion, listPlansForRoom, updatePlan } from '@/modules/space-planner-for-shop/lib/db/plans'
import { RoomWriteSchema, payloadTooLarge } from '@/modules/space-planner-for-shop/lib/validation'
import { displacedItems, normaliseGeometryWinding, normaliseOrigin, validateRoomGeometry } from '@/modules/space-planner-for-shop/lib/geometry'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { recordEvent } from '@/modules/space-planner-for-shop/lib/db/events'

// One room: read it, change it, delete it.
//
// The interesting one is PUT, because editing a room's geometry when it already
// has plans in it is the sharp edge of the whole model. It applies to all of
// them - that is the entire point of measuring once - and what it must not do is
// quietly destroy work. So an item that a wall move has pushed outside the
// outline, or that a new obstruction now sits on top of, is moved to that plan's
// STAGING TRAY and never deleted, each affected plan gets a version archived
// first, and the response says exactly what moved so the UI can name it.

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const room = await getRoomForMember(id, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const plans = await listPlansForRoom(id, gate.member.id)
  return NextResponse.json({
    room,
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      position: plan.position,
      itemCount: plan.items.items.filter((item) => !item.staged).length,
      updatedAt: plan.updatedAt,
      shared: Boolean(plan.shareToken),
    })),
  })
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const raw = await request.text()
  if (payloadTooLarge(raw)) {
    return NextResponse.json({ error: 'That space is bigger than we can store. Simplify the outline and try again.' }, { status: 413 })
  }
  // Geometry is optional as well as notes. Renaming a room is not a change to
  // its shape, and requiring one meant the rename button had to send whatever
  // the browser happened to be holding - so a wall dragged and not yet saved was
  // committed by typing a new name, and every OTHER layout in the room had its
  // furniture staged against an outline the member had not agreed to.
  const parsed = RoomWriteSchema.partial({ notes: true, geometry: true }).safeParse(safeJson(raw))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error?.issues[0]?.message ?? 'That space did not look right.' }, { status: 400 })
  }

  const existing = await getRoomForMember(id, gate.member.id)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Wound through the geometry-level version, which renumbers the doors and
  // windows along with the walls they hang on.
  const reshaping = parsed.data.geometry !== undefined
  const rewound = normaliseGeometryWinding(parsed.data.geometry ?? existing.geometry)
  const geometry = { ...rewound, vertices: normaliseOrigin(rewound.vertices) }
  if (reshaping) {
    const issues = validateRoomGeometry(geometry)
    if (issues.length > 0) {
      return NextResponse.json({ error: issues[0]?.message ?? 'That space did not look right.', issues }, { status: 400 })
    }
  }

  const config = await getSplConfigCached()
  const plans = await listPlansForRoom(id, gate.member.id)
  const affected: Array<{ planId: string; planName: string; displaced: string[] }> = []

  // Only when the shape actually changed. A rename cannot displace anything, and
  // running the pass anyway meant typing a new name restaged furniture in every
  // layout in the room and archived a version of each for the privilege.
  for (const plan of reshaping ? plans : []) {
    const displaced = displacedItems(plan.items.items, geometry)
    if (displaced.length === 0) continue

    // Archive before touching it. A wall moved ten centimetres should not
    // silently eat a pedestal, and "undo" that only lasts as long as the tab is
    // open is not much of a promise on a document somebody spent an afternoon on.
    await archivePlanVersion(plan, config.maxVersionsPerPlan, 'Before the space was re-measured')

    const displacedIds = new Set(displaced.map((item) => item.id))
    const nextItems = {
      ...plan.items,
      items: plan.items.items.map((item) =>
        displacedIds.has(item.id) || (item.parentId && displacedIds.has(item.parentId))
          ? { ...item, staged: true, parentId: null }
          : item,
      ),
    }
    await updatePlan(plan.id, gate.member.id, { items: nextItems })
    affected.push({ planId: plan.id, planName: plan.name, displaced: displaced.map((item) => item.id) })
  }

  const room = await updateRoom(id, gate.member.id, {
    name: parsed.data.name,
    notes: parsed.data.notes,
    // Left alone entirely on a rename, rather than written back unchanged.
    ...(reshaping ? { geometry } : {}),
  })
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await recordEvent('room.saved')
  return NextResponse.json({ room, affected })
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const ok = await deleteRoom(id, gate.member.id)
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
