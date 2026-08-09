import { NextResponse } from 'next/server'
import type { Member } from '@prisma/client'
import { getMemberFromCookie } from '@/lib/members/session'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { plannerHiddenResponse } from '@/modules/space-planner-for-shop/lib/visibility'
import { countRoomsForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { countPlansInRoom } from '@/modules/space-planner-for-shop/lib/db/plans'

// The member side of the gate. Everything the planner persists belongs to an
// account, so every write route starts here.
//
// Saving needing a sign-in is one deliberate product gate, taken in exchange for
// deleting a whole class of work: no anonymous rows, no client id, no guest
// retention sweep, no adoption reconciliation, and no unauthenticated write
// endpoint to defend. A signed-out visitor still gets the entire tool - their
// scratch space and layout live in localStorage exactly as the cart does - and
// the save button is the sign-in prompt.

export type MemberGate =
  | { member: Member; error?: undefined }
  | { member?: undefined; error: NextResponse }

export async function requireMember(): Promise<MemberGate> {
  // Staff-only mode first, and before the sign-in question: every member route
  // in this module comes through here, so this is the one place the feature can
  // be switched off for customers without eleven separate chances to forget one.
  // A staff member who is also signed in as a member carries on as normal.
  const hidden = await plannerHiddenResponse()
  if (hidden) return { error: hidden }

  const member = await getMemberFromCookie()
  if (!member) {
    return {
      error: NextResponse.json(
        { error: 'Sign in to save your layouts.', needsSignIn: true },
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

/**
 * How many things one layout may hold.
 *
 * Counted over what is PLACED IN THE SPACE. Anything still waiting under the
 * Waiting tab
 * has not been placed, and counting it produced the least helpful message this
 * module has ever shown: "that is 240 things in one layout, and we top out at
 * 200" about a space with nothing in it, because the shopper had arrived from a
 * twenty-line basket at a dozen apiece.
 */
export async function itemQuotaExceeded(items: Array<{ staged?: boolean }>): Promise<string | null> {
  const config = await getSplConfigCached()
  const placed = items.filter((item) => !item.staged).length
  if (placed <= config.maxItemsPerPlan) return null
  // "Layout", not "space": a space holds many layouts, the cap is per layout, and
  // the owner's own label for this setting is "Things in one layout". Two
  // functions above, this file already says "spaces" and "layouts" correctly.
  return `That is ${placed} things in one layout, and we top out at ${config.maxItemsPerPlan}. Split it across two layouts and they will still price up together.`
}
