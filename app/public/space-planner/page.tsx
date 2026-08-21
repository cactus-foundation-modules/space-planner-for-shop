import { notFound } from 'next/navigation'
import { getMemberFromCookie } from '@/lib/members/session'
import { getMemberAreaPath } from '@/lib/members/paths'
import { getShopGate } from '@/modules/shop/lib/access'
import { plannerVisible } from '@/modules/space-planner-for-shop/lib/visibility'
import { getPlanForMember, listPlansForMember } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForMember, listRoomsForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { polygonAreaM2 } from '@/modules/space-planner-for-shop/lib/geometry'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { ShopClosedNotice } from '@/modules/shop/components/public/ShopClosedNotice'
import { getProductBySlug } from '@/modules/shop/lib/db/products'
import { SpacePlanner } from '@/modules/space-planner-for-shop/components/public/SpacePlanner'
import type { OpenPlan, SavedRoomLink } from '@/modules/space-planner-for-shop/components/public/SpacePlanner'
import { getSplConfigCached, renderWorkerConfigured } from '@/modules/space-planner-for-shop/lib/config'
import { quoteRequestsOffered } from '@/modules/space-planner-for-shop/lib/quote'
import { recordEvent } from '@/modules/space-planner-for-shop/lib/db/events'
import { isTurnstileConfigured } from '@/lib/config/env'

export const metadata = { title: 'Plan your space' }

// /space-planner
//
// Module public pages always render inside the site header and footer on this
// platform - there is no chrome-free route to opt into - so the design target is
// full-bleed within <main>: the planner fills the viewport minus the sticky
// header. That is the honest layout here, and it keeps the site navigation
// present, which is what a shopper part-way through buying actually wants.
async function loadOpenPlan(
  params: Record<string, string | string[] | undefined>,
  memberId: string | null,
): Promise<OpenPlan | null> {
  if (!memberId) return null

  const planId = typeof params.plan === 'string' ? params.plan : null
  if (planId) {
    const plan = await getPlanForMember(planId, memberId)
    if (!plan) return null
    const room = await getRoomForMember(plan.roomId, memberId)
    if (!room) return null
    return { planId: plan.id, roomId: room.id, roomName: room.name, planName: plan.name, geometry: room.geometry, items: plan.items.items }
  }

  const roomId = typeof params.room === 'string' ? params.room : null
  if (roomId) {
    const room = await getRoomForMember(roomId, memberId)
    if (!room) return null
    return { planId: null, roomId: room.id, roomName: room.name, planName: 'New layout', geometry: room.geometry, items: [] }
  }

  return null
}

/** How many rooms the opening screen offers before pointing at My spaces. */
const OPENING_ROOM_LIMIT = 6

/**
 * The member's rooms, each pointing at the layout they last worked on.
 *
 * Two queries rather than one per room: the layouts come back in a single pass
 * for the whole member and are grouped here, so a member with a dozen rooms
 * costs the same as one with a single room. Nothing is asked at all for a
 * visitor who is signed out, or for one who is opening a saved plan and will
 * never see the opening screen.
 */
async function loadSavedRooms(memberId: string | null): Promise<SavedRoomLink[]> {
  if (!memberId) return []

  const [rooms, plans] = await Promise.all([listRoomsForMember(memberId), listPlansForMember(memberId)])
  // listPlansForMember answers newest-worked-on first, so the first plan seen
  // for a room is the one to reopen.
  const latest = new Map<string, string>()
  for (const plan of plans) {
    if (!latest.has(plan.roomId)) latest.set(plan.roomId, plan.id)
  }

  return rooms.slice(0, OPENING_ROOM_LIMIT).map((entry) => ({
    id: entry.room.id,
    name: entry.room.name,
    areaM2: polygonAreaM2(entry.room.geometry.vertices),
    planCount: entry.planCount,
    planId: latest.get(entry.room.id) ?? null,
  }))
}

export default async function SpacePlannerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const gate = await getShopGate()
  if (gate.blocked) return <ShopClosedNotice message={gate.message} />

  // Staff-only mode. The address is the feature, so hiding the buttons and
  // leaving this open would be hiding nothing at all - anyone who ever followed
  // a link, or guessed, would still be in.
  if (!(await plannerVisible())) notFound()

  const params = await searchParams
  const [config, member, shopConfig] = await Promise.all([getSplConfigCached(), getMemberFromCookie(), getShopConfigCached()])
  const signInHref = `/${getMemberAreaPath()}/login`

  // Somebody opened the planner, and where they came from.
  //
  // Three event names have been declared since the first release and NONE of
  // them was ever recorded, so "Opened this week" on the Plans screen and on the
  // admin dashboard tile read nought for ever - on a module in daily use. The
  // owner's read of that is "nobody is using this", which is the opposite of
  // what the data would have said.
  //
  // Fire-and-forget, like every other event in this module: a usage counter is
  // never a reason to fail a page, and recordEvent swallows its own errors.
  void recordEvent(
    params.from === 'cart'
      ? 'planner.opened-from-cart'
      : params.product || params.productSlug
        ? 'planner.opened-from-product'
        : 'planner.opened',
    { memberId: member?.id ?? null },
  )

  const productSlug = typeof params.productSlug === 'string' ? params.productSlug : null
  const staged = productSlug ? await getProductBySlug(productSlug) : null

  // Opening something already saved: ?plan=<id> is one layout, ?room=<id> is a
  // fresh layout in a room that has already been measured. Both are loaded here
  // rather than fetched from the browser, so the planner comes up with the room
  // already on screen instead of flashing the first-run screen at somebody who
  // has plainly already been past it. Ownership is enforced by the query itself:
  // neither lookup has a form that does not take a member id.
  const openPlan = await loadOpenPlan(params, member?.id ?? null)

  // Only for somebody who is about to see the opening screen: a page that opens
  // straight into a saved room never renders the list, so there is nothing to
  // fetch for it.
  const savedRooms = openPlan ? [] : await loadSavedRooms(member?.id ?? null)

  // Switched on and wired up are two different things, and the button is only
  // honest when both are true. Worked out here rather than in the browser so
  // nobody is offered a picture the site cannot take.
  const rendersAvailable = config.rendersEnabled && (await renderWorkerConfigured())

  // Same test, for the same reason: the owner's switch says they want the
  // button, the quotes module's mode says whether this shop invites quote
  // requests at all. A shop set to "normal shop" does not, anywhere else, so
  // the planner does not either.
  const quoteAvailable = config.quoteEnabled && (await quoteRequestsOffered())

  return (
    <div style={{ padding: 'var(--space-3)' }}>
      {/* Keyed on which room is being shown, because the planner is opened from
          this same route with different search parameters. The names, the save
          ids and the history are first-render state, so without a key a soft
          navigation from one saved room to another would draw the new room
          under the old one's name and save over the old one's layout. */}
      <SpacePlanner
        key={openPlan?.planId ?? openPlan?.roomId ?? 'new'}
        signedIn={Boolean(member)}
        signInHref={signInHref}
        heading={config.plannerHeading}
        intro={config.plannerIntro}
        budgets={{
          maxUniqueModels: config.maxUniqueModels,
          decimationTarget: config.decimationTarget,
          textureMaxPx: config.textureMaxPx,
          decimationEnabled: config.decimationEnabled,
        }}
        maxItemsPerPlan={config.maxItemsPerPlan}
        guidance={{
          walkwayClearanceMm: config.walkwayClearanceMm,
          disclaimer: config.guidanceDisclaimer,
          enabled: config.clearanceWarningsEnabled,
        }}
        priceDisclaimer={config.bomDisclaimer}
        currencySymbol={shopConfig.currencySymbol}
        rendersAvailable={rendersAvailable}
        quoteAvailable={quoteAvailable}
        emailAvailable={config.emailPlanEnabled}
        turnstileSiteKey={isTurnstileConfigured() ? process.env.TURNSTILE_SITE_KEY ?? null : null}
        member={member ? { name: member.displayName ?? '', email: member.email } : null}
        openPlan={openPlan}
        savedRooms={savedRooms}
        stageCart={params.from === 'cart'}
        stageProductId={typeof params.product === 'string' ? params.product : staged?.id ?? null}
      />
    </div>
  )
}
