import { getMemberFromCookie } from '@/lib/members/session'
import { getMemberAreaPath } from '@/lib/members/paths'
import { getShopGate } from '@/modules/shop/lib/access'
import { getPlanForMember } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { ShopClosedNotice } from '@/modules/shop/components/public/ShopClosedNotice'
import { getProductBySlug } from '@/modules/shop/lib/db/products'
import { SpacePlanner } from '@/modules/space-planner-for-shop/components/public/SpacePlanner'
import type { OpenPlan } from '@/modules/space-planner-for-shop/components/public/SpacePlanner'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'

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

export default async function SpacePlannerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const gate = await getShopGate()
  if (gate.blocked) return <ShopClosedNotice message={gate.message} />

  const params = await searchParams
  const [config, member, shopConfig] = await Promise.all([getSplConfigCached(), getMemberFromCookie(), getShopConfigCached()])
  const signInHref = `/${getMemberAreaPath()}/login`

  const productSlug = typeof params.productSlug === 'string' ? params.productSlug : null
  const staged = productSlug ? await getProductBySlug(productSlug) : null

  // Opening something already saved: ?plan=<id> is one layout, ?room=<id> is a
  // fresh layout in a room that has already been measured. Both are loaded here
  // rather than fetched from the browser, so the planner comes up with the room
  // already on screen instead of flashing the first-run screen at somebody who
  // has plainly already been past it. Ownership is enforced by the query itself:
  // neither lookup has a form that does not take a member id.
  const openPlan = await loadOpenPlan(params, member?.id ?? null)

  return (
    <div style={{ padding: 'var(--space-3)' }}>
      <SpacePlanner
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
        guidance={{
          walkwayClearanceMm: config.walkwayClearanceMm,
          disclaimer: config.guidanceDisclaimer,
          enabled: config.clearanceWarningsEnabled,
        }}
        currencySymbol={shopConfig.currencySymbol}
        openPlan={openPlan}
        stageCart={params.from === 'cart'}
        stageProductId={typeof params.product === 'string' ? params.product : staged?.id ?? null}
      />
    </div>
  )
}
