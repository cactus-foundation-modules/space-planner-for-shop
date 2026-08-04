import { NextRequest, NextResponse } from 'next/server'
import { recordMemberActivity } from '@/lib/members/activity'
import { requireMember, roomQuotaExceeded } from '@/modules/space-planner-for-shop/lib/member-gate'
import { createRoom, listRoomsForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { RoomWriteSchema, payloadTooLarge } from '@/modules/space-planner-for-shop/lib/validation'
import { normaliseOrigin, normaliseWinding, validateRoomGeometry } from '@/modules/space-planner-for-shop/lib/geometry'
import { recordEvent } from '@/modules/space-planner-for-shop/lib/db/events'

// GET  - this member's rooms, with their plan counts.
// POST - a new room.
//
// Both are MEMBER-tier (declared in the manifest's routeTiers) and both prove
// ownership through the data layer rather than trusting the tier: a route tier
// says "somebody is signed in", not "this is theirs".

export async function GET() {
  const gate = await requireMember()
  if (gate.error) return gate.error

  const rooms = await listRoomsForMember(gate.member.id)
  return NextResponse.json({
    rooms: rooms.map((entry) => ({
      id: entry.room.id,
      name: entry.room.name,
      notes: entry.room.notes,
      geometry: entry.room.geometry,
      thumbnailMediaId: entry.room.thumbnailMediaId,
      planCount: entry.planCount,
      lastEditedAt: entry.lastEditedAt,
      createdAt: entry.room.createdAt,
    })),
  })
}

export async function POST(request: NextRequest) {
  const gate = await requireMember()
  if (gate.error) return gate.error

  // Size first, shape second. zod will happily walk a ten-megabyte object and
  // pronounce it valid, so the cheap guard has to come before the thorough one.
  const raw = await request.text()
  if (payloadTooLarge(raw)) {
    return NextResponse.json({ error: 'That room is bigger than we can store. Simplify the outline and try again.' }, { status: 413 })
  }

  const parsed = RoomWriteSchema.safeParse(safeJson(raw))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error?.issues[0]?.message ?? 'That room did not look right.' }, { status: 400 })
  }

  const quota = await roomQuotaExceeded(gate.member.id)
  if (quota) return NextResponse.json({ error: quota }, { status: 409 })

  const geometry = {
    ...parsed.data.geometry,
    vertices: normaliseOrigin(normaliseWinding(parsed.data.geometry.vertices)),
  }
  const issues = validateRoomGeometry(geometry)
  if (issues.length > 0) {
    return NextResponse.json({ error: issues[0]?.message ?? 'That room did not look right.', issues }, { status: 400 })
  }

  const room = await createRoom({
    memberId: gate.member.id,
    name: parsed.data.name,
    notes: parsed.data.notes,
    geometry,
  })

  await recordEvent('room.saved')
  await recordMemberActivity(gate.member.id, 'space-planner.room-saved', {
    source: 'space-planner-for-shop',
    metadata: { roomId: room.id },
  }).catch(() => {})

  return NextResponse.json({ room })
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
