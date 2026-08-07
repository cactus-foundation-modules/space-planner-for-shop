'use client'

import { useState, useTransition } from 'react'
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
        {error && <span style={errorStyle}>{error}</span>}
        <button
          type="button"
          onClick={() => {
            setError(null)
            setArmed(true)
          }}
          style={quietStyle}
          aria-label={props.target === 'room' ? `Delete the room ${props.name}` : `Delete the layout ${props.name}`}
        >
          Delete
        </button>
      </span>
    )
  }

  return (
    <span style={wrapStyle}>
      <span style={{ fontSize: 'var(--text-sm, 0.875rem)', color: 'var(--color-text-muted)' }}>
        {props.target === 'room'
          ? `Delete "${props.name}"${props.planCount ? ` and its ${props.planCount} ${props.planCount === 1 ? 'layout' : 'layouts'}` : ''}?`
          : `Delete "${props.name}"?`}
      </span>
      <button type="button" onClick={remove} disabled={working} style={dangerStyle}>
        {working ? 'Deleting…' : 'Yes, delete'}
      </button>
      <button type="button" onClick={() => setArmed(false)} disabled={working} style={quietStyle}>
        Keep it
      </button>
    </span>
  )
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
  minHeight: '2.25rem',
}

const quietStyle: CSSProperties = { ...baseButton, color: 'var(--color-text-muted)' }

const dangerStyle: CSSProperties = {
  ...baseButton,
  color: 'var(--color-danger, #b3261e)',
  borderColor: 'var(--color-danger, #b3261e)',
}

const errorStyle: CSSProperties = {
  color: 'var(--color-danger, #b3261e)',
  fontSize: 'var(--text-sm, 0.875rem)',
}
