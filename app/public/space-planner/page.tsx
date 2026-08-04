import { getMemberFromCookie } from '@/lib/members/session'
import { getMemberAreaPath } from '@/lib/members/paths'
import { getShopGate } from '@/modules/shop/lib/access'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { ShopClosedNotice } from '@/modules/shop/components/public/ShopClosedNotice'
import { getProductBySlug } from '@/modules/shop/lib/db/products'
import { SpacePlanner } from '@/modules/space-planner-for-shop/components/public/SpacePlanner'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'

export const metadata = { title: 'Plan your space' }

// /space-planner
//
// Module public pages always render inside the site header and footer on this
// platform - there is no chrome-free route to opt into - so the design target is
// full-bleed within <main>: the planner fills the viewport minus the sticky
// header. That is the honest layout here, and it keeps the site navigation
// present, which is what a shopper part-way through buying actually wants.
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
        stageCart={params.from === 'cart'}
        stageProductId={typeof params.product === 'string' ? params.product : staged?.id ?? null}
      />
    </div>
  )
}
