import { prisma } from '@/lib/db/prisma'
import { readSavedCamera } from '@/modules/space-planner-for-shop/lib/validation'
import type { SavedCamera, SplRoomView } from '@/modules/space-planner-for-shop/lib/types'

// Saved viewpoints, read and written only through a room the caller has already
// proved is theirs.
//
// Nothing in here takes a member id, and that is not an oversight. The table has
// no ownership column - the room is the authority - so every function here is
// documented as taking a room id the CALLER has already fetched with
// getRoomForMember. A second copy of the ownership answer living down here is
// how the two versions drift apart, and the drift is always in the permissive
// direction.

type ViewRow = {
  id: string
  room_id: string
  name: string
  position: number
  camera: unknown
  created_at: Date
  updated_at: Date
}

/**
 * Null when the stored camera will not parse - a room reshaped under a saved
 * view can leave a pose describing nowhere, and the list simply drops it rather
 * than offering the member a button that produces a black picture.
 */
function toView(row: ViewRow): SplRoomView | null {
  const camera = readSavedCamera(row.camera)
  if (!camera) return null
  return {
    id: row.id,
    roomId: row.room_id,
    name: row.name,
    position: row.position,
    camera,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Every viewpoint saved against one room, in the member's own order. */
export async function listViewsForRoom(roomId: string): Promise<SplRoomView[]> {
  const rows = await prisma.$queryRaw<ViewRow[]>`
    SELECT * FROM "spl_room_views" WHERE "room_id" = ${roomId}
    ORDER BY "position" ASC, "created_at" ASC
  `
  return rows.map(toView).filter((view): view is SplRoomView => view !== null)
}

export async function getView(viewId: string, roomId: string): Promise<SplRoomView | null> {
  const rows = await prisma.$queryRaw<ViewRow[]>`
    SELECT * FROM "spl_room_views" WHERE "id" = ${viewId} AND "room_id" = ${roomId} LIMIT 1
  `
  return rows[0] ? toView(rows[0]) : null
}

export async function countViewsForRoom(roomId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "spl_room_views" WHERE "room_id" = ${roomId}
  `
  return Number(rows[0]?.count ?? 0)
}

/**
 * Save a viewpoint at the end of the room's list.
 *
 * The position is worked out in the INSERT rather than read first and written
 * second, so two tabs saving a view at the same moment cannot both decide they
 * are number three. Positions are a display order, not a key, so a collision
 * would be survivable - but it would also be the kind of thing nobody ever finds
 * time to explain.
 */
/**
 * Save a viewpoint, refusing to go past the cap.
 *
 * The cap is checked in the INSERT itself rather than only in the route, so two
 * requests arriving together cannot both read "eleven saved" and both write a
 * twelfth. Nothing dreadful happens when they do - it is a list of camera angles
 * - but it is the one quota in the module that had no backstop at all, and the
 * check costs a WHERE clause.
 */
export async function createView(input: { roomId: string; name: string; camera: SavedCamera; max: number }): Promise<SplRoomView | null> {
  const rows = await prisma.$queryRaw<ViewRow[]>`
    INSERT INTO "spl_room_views" ("room_id", "name", "camera", "position")
    SELECT
      ${input.roomId},
      ${input.name},
      ${JSON.stringify(input.camera)}::jsonb,
      COALESCE((SELECT MAX("position") + 1 FROM "spl_room_views" WHERE "room_id" = ${input.roomId}), 0)
    WHERE (SELECT COUNT(*) FROM "spl_room_views" WHERE "room_id" = ${input.roomId}) < ${input.max}
    RETURNING *
  `
  return rows[0] ? toView(rows[0]) : null
}

export async function updateView(
  viewId: string,
  roomId: string,
  patch: { name?: string; camera?: SavedCamera; position?: number },
): Promise<SplRoomView | null> {
  const current = await getView(viewId, roomId)
  if (!current) return null

  const name = patch.name ?? current.name
  const camera = patch.camera ?? current.camera
  const position = patch.position ?? current.position

  const rows = await prisma.$queryRaw<ViewRow[]>`
    UPDATE "spl_room_views"
    SET "name" = ${name},
        "camera" = ${JSON.stringify(camera)}::jsonb,
        "position" = ${position},
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${viewId} AND "room_id" = ${roomId}
    RETURNING *
  `
  return rows[0] ? toView(rows[0]) : null
}

export async function deleteView(viewId: string, roomId: string): Promise<boolean> {
  const deleted = await prisma.$executeRaw`
    DELETE FROM "spl_room_views" WHERE "id" = ${viewId} AND "room_id" = ${roomId}
  `
  return deleted > 0
}
