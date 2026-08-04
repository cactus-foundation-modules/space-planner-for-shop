import { NextResponse } from 'next/server'
import type { Member } from '@prisma/client'
import { getMemberFromCookie } from '@/lib/members/session'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { countRoomsForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { countPlansInRoom } from '@/modules/space-planner-for-shop/lib/db/plans'

// The member side of the gate. Everything the planner persists belongs to an
// account, so every write route starts here.
//
// Saving needing a sign-in is one deliberate product gate, taken in exchange for
// deleting a whole class of work: no anonymous rows, no client id, no guest
// retention sweep, no adoption reconciliation, and no unauthenticated write
// endpoint to defend. A signed-out visitor still gets the entire tool - their
// scratch room and layout live in localStorage exactly as the cart does - and
// the save button is the sign-in prompt.

export type MemberGate =
  | { member: Member; error?: undefined }
  | { member?: undefined; error: NextResponse }

export async function requireMember(): Promise<MemberGate> {
  const member = await getMemberFromCookie()
  if (!member) {
    return {
      error: NextResponse.json(
        { error: 'Sign in to save your plans.', needsSignIn: true },
        { status: 401 },
      ),
    }
  }
  return { member }
}

/**
 * Quota checks, phrased as sentences.
 *
 * A shopper who has hit a limit is not debugging an API; they are trying to save
 * their office layout. A 400 with a code tells them nothing, so these return the
 * message the UI shows verbatim.
 */
export async function roomQuotaExceeded(memberId: string): Promise<string | null> {
  const config = await getSplConfigCached()
  const count = await countRoomsForMember(memberId)
  if (count < config.maxRoomsPerMember) return null
  return `You have ${count} spaces saved, which is as many as we keep. Delete one you have finished with and try again.`
}

export async function planQuotaExceeded(roomId: string): Promise<string | null> {
  const config = await getSplConfigCached()
  const count = await countPlansInRoom(roomId)
  if (count < config.maxPlansPerRoom) return null
  return `This space already has ${count} layouts in it. Delete one you no longer need and try again.`
}

export async function itemQuotaExceeded(itemCount: number): Promise<string | null> {
  const config = await getSplConfigCached()
  if (itemCount <= config.maxItemsPerPlan) return null
  return `That is ${itemCount} things in one room, and we top out at ${config.maxItemsPerPlan}. Split it into two plans and they will still price up together.`
}
