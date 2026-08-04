import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import {
  SpacePlannerTeaser,
  spacePlannerTeaserPuckComponent,
  type SpacePlannerTeaserProps,
} from '@/modules/space-planner-for-shop/components/puck/SpacePlannerTeaser'

// Storefront half. The block is entirely static, so both paths emit identical
// markup and classes - which is the invariant Puck blocks are held to on this
// platform, and the one that quietly breaks when an editor preview takes a
// shortcut the real page does not. The editor keeps showing it in staff-only
// mode so the owner can still place it and see what it will look like, exactly
// as the product button block already behaves when it is switched off.
//
// The switch is read from the settings ALONE here - no session, on purpose.
// Ordinary pages are prerendered and cached indefinitely, and reading a cookie
// in a block would quietly turn every page carrying it into a per-request
// render. A teaser is advertising, so there is nothing lost by staff not seeing
// it either; they go straight to the planner's own address.
export async function SpacePlannerTeaserRsc(props: SpacePlannerTeaserProps) {
  const config = await getSplConfigCached()
  if (config.adminOnly) return null
  return <SpacePlannerTeaser {...props} />
}

export const spacePlannerTeaserPuckRscComponent = {
  ...spacePlannerTeaserPuckComponent,
  render: SpacePlannerTeaserRsc,
}
