import { plannerCss } from '@/modules/space-planner-for-shop/components/public/planner-css'
import { PlannerLaunchButton } from '@/modules/space-planner-for-shop/components/public/PlannerLaunchButton'

// "See it in your room", for the product page.
//
// A block rather than a claim on shop's product-detail parts, and deliberately:
// that point is a slot-REPLACEMENT contract - whoever claims it owns the
// gallery, the price and the purchase area - and shop-variations already claims
// it on this shop. Contributing a second provider there would put two option
// pickers on the page, which is a defect this platform has already shipped once.
//
// So the owner places this where they want it, which is also where it belongs:
// under the buy button on a desk, and nowhere at all on a box of pens.

export type SpacePlannerProductButtonProps = {
  label?: string
  primary?: boolean
}

export function SpacePlannerProductButton(props: SpacePlannerProductButtonProps) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: plannerCss() }} />
      <PlannerLaunchButton label={props.label?.trim() || 'See it in your space'} from="product" primary={props.primary} />
    </>
  )
}

export const spacePlannerProductButtonPuckComponent = {
  label: 'Space Planner: see it in your space',
  fields: {
    label: { type: 'text' as const, label: 'Button label' },
    primary: {
      type: 'radio' as const,
      label: 'Prominence',
      options: [
        { label: 'Secondary', value: false },
        { label: 'Primary', value: true },
      ],
    },
  },
  defaultProps: { label: 'See it in your space', primary: false },
  render: SpacePlannerProductButton,
}
