'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Model corrections.
//
// A worst-offenders view rather than an index: models nobody has looked at,
// most-placed first. Ten minutes here pointed at the twelve models customers
// actually use is worth a great deal; the same ten minutes spent alphabetically
// is worth nothing.

type Entry = {
  modelId: string
  productId: string
  url: string
  format: string
  placements: number
  /** The corrections as they stand, so the form can show them rather than
   * rendering every model as untouched whatever was saved last week. */
  yawOffsetDegrees: number
  noDecimation: boolean
}

export function ModelsScreen() {
  const [models, setModels] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState('')
  const [status, setStatus] = useState('')
  /** The row with a save in flight, so its controls sit out one round. */
  const [savingId, setSavingId] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/m/space-planner-for-shop/admin/models')
      if (!response.ok) throw new Error()
      const data = (await response.json()) as { models: Entry[] }
      if (!mounted.current) return
      setModels(data.models)
      setProblem('')
    } catch {
      if (mounted.current) setProblem('The model list would not load. Check the connection and refresh.')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Awaited inside the effect rather than fired off through the shared
    // loader, so the state updates land after the first paint instead of
    // cascading a second render out of the first one.
    void (async () => {
      await load()
    })()
  }, [load])

  const save = async (modelId: string, patch: Record<string, unknown>) => {
    if (savingId) return
    setSavingId(modelId)
    setStatus('Saving…')
    try {
      const response = await fetch('/api/m/space-planner-for-shop/admin/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'file', modelId, ...patch }),
      })
      if (!mounted.current) return
      if (!response.ok) throw new Error()
      // Shown against the stored truth rather than assumed: reloading is what
      // makes the select and the tick display what actually saved.
      setStatus('Saved.')
      await load()
    } catch {
      if (mounted.current) setStatus('That did not save. Check the connection and try again.')
    } finally {
      if (mounted.current) setSavingId(null)
    }
  }

  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <h1 style={{ margin: 0 }}>Model corrections</h1>
      <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
        Models nobody has checked yet, busiest first. Turning one round or telling us to leave it alone takes a second and
        it stays fixed - no need to re-export anything.
      </p>
      {problem && <p style={{ margin: 0, color: 'var(--color-danger)' }}>{problem}</p>}
      {status && <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }} role="status">{status}</p>}

      {loading ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
      ) : models.length === 0 && !problem ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Everything has been looked at. Well done.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left" style={cell}>File</th>
              <th align="right" style={cell}>Placed</th>
              <th align="left" style={cell}>Turn it</th>
              <th align="left" style={cell}>Leave detail alone</th>
              <th align="left" style={cell}>Checked</th>
            </tr>
          </thead>
          <tbody>
            {models.map((entry) => {
              const busy = savingId === entry.modelId
              const file = entry.url.split('/').pop()?.split('?')[0]
              // A yaw set to something off the quarter turns - by hand, by an
              // import - still has to be shown, or the select would quietly
              // display 0° over a stored 45.
              const yawChoices = [0, 90, 180, 270].includes(entry.yawOffsetDegrees)
                ? [0, 90, 180, 270]
                : [entry.yawOffsetDegrees, 0, 90, 180, 270]
              return (
                <tr key={entry.modelId}>
                  <td style={cell}>
                    <code style={{ fontSize: 'var(--text-xs)' }}>{file}</code>
                  </td>
                  <td align="right" style={cell}>{entry.placements}</td>
                  <td style={cell}>
                    <select
                      className="form-input"
                      aria-label={`Turn ${file}`}
                      value={String(entry.yawOffsetDegrees)}
                      disabled={busy}
                      onChange={(event) => void save(entry.modelId, { yawOffsetDegrees: Number(event.target.value) })}
                    >
                      {yawChoices.map((degrees) => (
                        <option key={degrees} value={degrees}>{degrees}°</option>
                      ))}
                    </select>
                  </td>
                  <td style={cell}>
                    <input
                      type="checkbox"
                      aria-label={`Leave detail alone for ${file}`}
                      checked={entry.noDecimation}
                      disabled={busy}
                      onChange={(event) => void save(entry.modelId, { noDecimation: event.target.checked })}
                    />
                  </td>
                  <td style={cell}>
                    <button type="button" className="btn" disabled={busy} onClick={() => void save(entry.modelId, { reviewed: true })}>
                      {busy ? 'Saving…' : 'Mark checked'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

const cell: React.CSSProperties = { padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)' }
