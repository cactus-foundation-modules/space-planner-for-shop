import { NextRequest, NextResponse } from 'next/server'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { deleteView, updateView } from '@/modules/space-planner-for-shop/lib/db/room-views'
import { ViewPatchSchema, payloadTooLarge } from '@/modules/space-planner-for-shop/lib/validation'
import type { SavedCamera } from '@/modules/space-planner-for-shop/lib/types'

// Rename a saved view, re-point it at where the member is standing now, or throw
// it away.
//
// Both handlers prove the room first and then scope every statement by BOTH ids.
// A view id on its own would be enough to rename somebody else's viewpoint,
// which is a small thing to leak and a very silly one.

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string; viewId: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id, viewId } = await context.params

  const room = await getRoomForMember(id, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const raw = await request.text()
  if (payloadTooLarge(raw)) {
    return NextResponse.json({ error: 'That view did not look right.' }, { status: 413 })
  }
  const parsed = ViewPatchSchema.safeParse(safeJson(raw))
  if (!parsed.success) {
    return NextResponse.json({ error: 'That view did not look right.' }, { status: 400 })
  }

  const view = await updateView(viewId, id, {
    name: parsed.data.name,
    camera: parsed.data.camera as SavedCamera | undefined,
    position: parsed.data.position,
  })
  if (!view) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ view })
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string; viewId: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id, viewId } = await context.params

  const room = await getRoomForMember(id, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const gone = await deleteView(viewId, id)
  if (!gone) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
