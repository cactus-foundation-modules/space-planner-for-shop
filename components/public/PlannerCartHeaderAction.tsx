import { plannerCss } from '@/modules/space-planner-for-shop/components/public/planner-css'
import { PlannerLaunchButton } from '@/modules/space-planner-for-shop/components/public/PlannerLaunchButton'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'

// The planner's control on shop's `shop.cart-header-actions` point.
//
// The basket is where a fit-out buyer has already assembled the shopping list
// and is at their most receptive to "will this actually fit?", which makes it the
// planner's highest-intent entry point.
//
// Secondary styling, deliberately: checkout stays the primary action. quote-for-shop
// already puts two controls in this same row, so this is the third - the row is
// checked on a phone because that is where it will crowd first.
//
// It hides itself on an empty basket rather than sitting there disabled, and it
// works perfectly well signed out: sign-in is asked for at save, not at entry.
export async function PlannerCartHeaderAction() {
  const config = await getSplConfigCached()
  if (!config.showOnCart) return null

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: plannerCss() }} />
      <PlannerLaunchButton label={config.cartButtonLabel} from="cart" hideWhenCartEmpty />
    </>
  )
}
