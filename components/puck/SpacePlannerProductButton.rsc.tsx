import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import {
  SpacePlannerProductButton,
  spacePlannerProductButtonPuckComponent,
  type SpacePlannerProductButtonProps,
} from '@/modules/space-planner-for-shop/components/puck/SpacePlannerProductButton'

// Storefront half. Same markup, same classes; the only difference is that the
// owner's default wording is read server-side, so leaving the field blank on
// forty product layouts still gives one label to change in one place.
export async function SpacePlannerProductButtonRsc(props: SpacePlannerProductButtonProps) {
  const config = await getSplConfigCached()
  if (!config.showOnProduct) return null
  return <SpacePlannerProductButton {...props} label={props.label?.trim() || config.productButtonLabel} />
}

export const spacePlannerProductButtonPuckRscComponent = {
  ...spacePlannerProductButtonPuckComponent,
  render: SpacePlannerProductButtonRsc,
}
