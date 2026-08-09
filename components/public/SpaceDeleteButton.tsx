'use client'

import { useCallback, useState, useTransition } from 'react'
import type { CSSProperties } from 'react'
import { useRouter } from 'next/navigation'

// Throwing a room or a layout away from the library.
//
// Two taps rather than a browser confirm(). confirm() is suppressed outright in
// a few in-app browsers - the ones a link from an email opens in - and there it
// resolves false, so the button would appear to do nothing at all. The one
// control that must never silently no-op is the one that deletes an afternoon's
// work, so the confirmation is built out of the same buttons as everything else.
//
// The page around this is a server component. On success it is refreshed rather
// than patched here: a row hidden locally and a list still holding it is two
// versions of the truth, and the next navigation picks the wrong one.

export type SpaceDeleteTarget = 'room' | 'plan'

type Props = {
  target: SpaceDeleteTarget
  id: string
  /** What it is called, so the confirmation names the thing rather than saying "this". */
  name: string
  /** Layouts inside a room, so somebody about to lose four of them is told first. */
  planCount?: number
}

export function SpaceDeleteButton(props: Props) {
  const router = useRouter()
  const [armed, setArmed] = useState(false)
  // A callback ref rather than an effect: it fires as the confirm button
  // mounts, which is exactly when focus needs to move onto it. Arming used to
  // unmount the focused Delete button and mount a span in its place, so focus
  // fell to the document and a keyboard user had to tab back in from the top of
  // the page to answer a question they had just asked for.
  const confirmRef = useCallback((node: HTMLButtonElement | null) => {
    node?.focus()
  }, [])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, startTransition] = useTransition()
  const working = sending || refreshing

  const remove = async () => {
    setSending(true)
    setError(null)
    try {
      const path = props.target === 'room' ? 'rooms' : 'plans'
      const response = await fetch(`/api/m/space-planner-for-shop/member/${path}/${encodeURIComponent(props.id)}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        setError(response.status === 404 ? 'That one has gone already.' : 'It would not delete. Try again in a moment.')
        return
      }
      setArmed(false)
      startTransition(() => router.refresh())
    } catch {
      setError('It would not delete. Check your connection and try again.')
    } finally {
      setSending(false)
    }
  }

  if (!armed) {
    return (
      <span style={wrapStyle}>
        <span role="status" aria-live="polite" style={srOnly}>{error ?? ''}</span>
        {error && <span style={errorStyle} aria-hidden="true">{error}</span>}
        <button
          type="button"
          onClick={() => {
            setError(null)
            setArmed(true)
          }}
          style={quietStyle}
          aria-label={props.target === 'room' ? `Delete the space ${props.name}` : `Delete the layout ${props.name}`}
        >
          Delete
        </button>
      </span>
    )
  }

  return (
    <span style={wrapStyle}>
      {/* A delete that FAILS was completely silent to a screen reader: the
          message was a conditionally-mounted span with no live region. */}
      <span role="status" aria-live="polite" style={srOnly}>{error ?? ''}</span>
      {error && <span style={errorStyle} aria-hidden="true">{error}</span>}
      <span style={{ fontSize: 'var(--text-sm, 0.875rem)', color: 'var(--color-text-secondary)' }}>
        {props.target === 'room'
          ? `Delete "${props.name}"${props.planCount ? ` and its ${props.planCount} ${props.planCount === 1 ? 'layout' : 'layouts'}` : ''}?`
          : `Delete "${props.name}"?`}
      </span>
      {/* Named, because several rows can be armed at once and an unlabelled
          "Yes, delete" repeated down a list tells a screen-reader user nothing
          about which one they are on. Focused on arming, too: the two branches
          return different elements at the same position, so React unmounted the
          button that had focus and focus fell to the document. */}
      <button
        type="button"
        ref={confirmRef}
        onClick={remove}
        disabled={working}
        style={dangerStyle}
        aria-label={props.target === 'room' ? `Yes, delete the space ${props.name}` : `Yes, delete the layout ${props.name}`}
      >
        {working ? 'Deleting…' : 'Yes, delete'}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        disabled={working}
        style={quietStyle}
        aria-label={`Keep ${props.name}`}
      >
        Keep it
      </button>
    </span>
  )
}

/** Announced, never seen. Inline rather than a class: this button renders on
 *  My spaces, which does not carry the planner's own stylesheet. */
const srOnly: CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
}

const wrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  flexWrap: 'wrap',
}

const baseButton: CSSProperties = {
  border: '1px solid var(--color-border)',
  background: 'transparent',
  borderRadius: 'var(--radius-sm, 6px)',
  padding: '0.25rem 0.55rem',
  fontSize: 'var(--text-sm, 0.875rem)',
  cursor: 'pointer',
  // A fingertip is not a pointer, and this sits in a list of rows that are
  // themselves links: too small a target here is a tap that opens the layout.
  //
  // 2.75rem, and set here rather than left to the module's coarse-pointer block
  // - an inline style is what @media cannot reach, so naming the hazard above
  // and then shipping a 36px target was the one control the rule could not
  // rescue.
  minHeight: '2.75rem',
}

// Full-strength text, not the secondary tone: this is the button's own label,
// and a control is not supporting text. Quiet here means quiet in weight and
// border, not in contrast.
const quietStyle: CSSProperties = { ...baseButton, color: 'var(--color-text)' }

const dangerStyle: CSSProperties = {
  ...baseButton,
  color: 'var(--color-danger, #b3261e)',
  borderColor: 'var(--color-danger, #b3261e)',
}

const errorStyle: CSSProperties = {
  color: 'var(--color-danger, #b3261e)',
  fontSize: 'var(--text-sm, 0.875rem)',
}
