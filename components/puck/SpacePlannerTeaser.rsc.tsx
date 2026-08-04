import {
  SpacePlannerTeaser,
  spacePlannerTeaserPuckComponent,
  type SpacePlannerTeaserProps,
} from '@/modules/space-planner-for-shop/components/puck/SpacePlannerTeaser'

// Storefront half. The block is entirely static, so both paths emit identical
// markup and classes - which is the invariant Puck blocks are held to on this
// platform, and the one that quietly breaks when an editor preview takes a
// shortcut the real page does not.
export function SpacePlannerTeaserRsc(props: SpacePlannerTeaserProps) {
  return <SpacePlannerTeaser {...props} />
}

export const spacePlannerTeaserPuckRscComponent = {
  ...spacePlannerTeaserPuckComponent,
  render: SpacePlannerTeaserRsc,
}
