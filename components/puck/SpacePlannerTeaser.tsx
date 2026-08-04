import { plannerCss } from '@/modules/space-planner-for-shop/components/public/planner-css'
import { PlannerLaunchButton } from '@/modules/space-planner-for-shop/components/public/PlannerLaunchButton'

// A STATIC teaser, and static on purpose.
//
// The block is an image and a button. The planner itself - three.js, the model
// pipeline, the whole application - loads only on its own page, when the shopper
// has actually asked for it. A block that dragged a 3D engine onto every page it
// sat on would be a tax on the whole site for the benefit of one feature, and it
// is exactly the kind of thing that gets a feature switched off.

export type SpacePlannerTeaserProps = {
  heading?: string
  body?: string
  buttonLabel?: string
  imageUrl?: string
  align?: 'left' | 'centre'
}

export function SpacePlannerTeaser(props: SpacePlannerTeaserProps) {
  const align = props.align === 'centre' ? 'center' : 'left'
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: plannerCss() }} />
      <div
        style={{
          display: 'grid',
          gap: 'var(--space-3)',
          justifyItems: align === 'center' ? 'center' : 'start',
          textAlign: align,
          padding: 'var(--space-4)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md, 10px)',
          background: 'var(--color-surface)',
        }}
      >
        {props.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- the owner picks any url here, including one from outside the media library
          <img
            src={props.imageUrl}
            alt=""
            style={{ maxWidth: '100%', borderRadius: 'var(--radius-md, 10px)' }}
          />
        )}
        <h2 style={{ margin: 0, fontSize: 'var(--text-xl, 1.35rem)', color: 'var(--color-text)' }}>
          {props.heading?.trim() || 'Plan your space'}
        </h2>
        <p style={{ margin: 0, color: 'var(--color-text-muted)', maxWidth: '38rem' }}>
          {props.body?.trim() || 'Draw your room, drop our furniture into it, and see what fits before you buy a thing.'}
        </p>
        <PlannerLaunchButton label={props.buttonLabel?.trim() || 'Open the Space Planner'} from="plain" primary />
      </div>
    </>
  )
}

export const spacePlannerTeaserPuckComponent = {
  label: 'Space Planner: teaser',
  fields: {
    heading: { type: 'text' as const, label: 'Heading' },
    body: { type: 'textarea' as const, label: 'Wording' },
    buttonLabel: { type: 'text' as const, label: 'Button label' },
    imageUrl: { type: 'text' as const, label: 'Picture URL (optional)' },
    align: {
      type: 'select' as const,
      label: 'Alignment',
      options: [
        { label: 'Left', value: 'left' },
        { label: 'Centred', value: 'centre' },
      ],
    },
  },
  defaultProps: {
    heading: 'Plan your space',
    body: 'Draw your room, drop our furniture into it, and see what fits before you buy a thing.',
    buttonLabel: 'Open the Space Planner',
    imageUrl: '',
    align: 'left' as const,
  },
  render: SpacePlannerTeaser,
}
