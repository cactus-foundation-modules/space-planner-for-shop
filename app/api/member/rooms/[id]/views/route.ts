import { NextRequest, NextResponse } from 'next/server'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { countViewsForRoom, createView, listViewsForRoom } from '@/modules/space-planner-for-shop/lib/db/room-views'
import { MAX_VIEWS_PER_ROOM, ViewWriteSchema, payloadTooLarge } from '@/modules/space-planner-for-shop/lib/validation'
import type { SavedCamera } from '@/modules/space-planner-for-shop/lib/types'

// The saved viewpoints inside one room. GET lists them; POST saves another.
//
// Ownership is proved on the ROOM, exactly as the plans route does it, and for
// the same reason: a room id is not a capability. The views table has no member
// column of its own, so this fetch is the whole of the access check and it has
// to come first in both handlers.

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const room = await getRoomForMember(id, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ views: await listViewsForRoom(id) })
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const room = await getRoomForMember(id, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const raw = await request.text()
  if (payloadTooLarge(raw)) {
    return NextResponse.json({ error: 'That view did not look right.' }, { status: 413 })
  }
  const parsed = ViewWriteSchema.safeParse(safeJson(raw))
  if (!parsed.success) {
    return NextResponse.json({ error: 'That view did not look right.' }, { status: 400 })
  }

  // A dozen angles on one room is already more than anybody compares. The cap is
  // here rather than in the UI alone because the UI is not the only caller once
  // somebody has a browser console.
  if ((await countViewsForRoom(id)) >= MAX_VIEWS_PER_ROOM) {
    return NextResponse.json(
      { error: `You have ${MAX_VIEWS_PER_ROOM} views saved for this space, which is as many as we keep. Delete one you have finished with.` },
      { status: 409 },
    )
  }

  // The cap is checked again inside the INSERT, so two requests arriving
  // together cannot both pass the count above. A null answer means the other one
  // got there first, which reads to the member exactly like being at the cap -
  // because they are.
  const view = await createView({
    roomId: id,
    name: parsed.data.name,
    camera: parsed.data.camera as SavedCamera,
    max: MAX_VIEWS_PER_ROOM,
  })
  if (!view) {
    return NextResponse.json(
      { error: `You have ${MAX_VIEWS_PER_ROOM} views saved for this space, which is as many as we keep. Delete one you have finished with.` },
      { status: 409 },
    )
  }
  return NextResponse.json({ view })
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
