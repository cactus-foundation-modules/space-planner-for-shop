'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Model corrections.
//
// A worst-offenders view rather than an index: models nobody has looked at,
// most-placed first. Ten minutes here pointed at the twelve models customers
// actually use is worth a great deal; the same ten minutes spent alphabetically
// is worth nothing.

/** How many rows the list endpoint hands back. Mirrors the route's own limit, so
 * the screen can say the list is the first fifty rather than imply it is all. */
const MODEL_LIST_LIMIT = 50

type Entry = {
  modelId: string
  productId: string
  /** Which product the file belongs to - a person cannot tell forty chairs
   * apart by their export filenames. Empty when the product has gone. */
  productName: string
  url: string
  format: string
  placements: number
  /** The corrections as they stand, so the form can show them rather than
   * rendering every model as untouched whatever was saved last week. */
  yawOffsetDegrees: number
  noDecimation: boolean
  /** Whether somebody has already said this one is right. Only ever true in the
   * list when the checked ones have been asked for. */
  reviewed: boolean
}

export function ModelsScreen() {
  const [models, setModels] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState('')
  const [status, setStatus] = useState('')
  /** The row with a save in flight, so its controls sit out one round. */
  const [savingId, setSavingId] = useState<string | null>(null)
  /** Checked models are out of the way by default - the list is meant to be the
   * work outstanding - but a rotation noticed as wrong next week has to be
   * reachable, and this is the only screen that can put it right. */
  const [showChecked, setShowChecked] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const load = useCallback(async (includeChecked: boolean) => {
    try {
      const response = await fetch(`/api/m/space-planner-for-shop/admin/models${includeChecked ? '?includeReviewed=1' : ''}`)
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
      await load(showChecked)
    })()
  }, [load, showChecked])

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
      if (response.status === 403) {
        setStatus('Your account can look but not change a model - that needs the Space Planner manage permission.')
        return
      }
      // The route's own sentence where it wrote one, rather than "check the
      // connection" printed over a server fault the owner can act on.
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? '')
      }
      // Shown against the stored truth rather than assumed: reloading is what
      // makes the select and the tick display what actually saved.
      setStatus('Saved.')
      await load(showChecked)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (mounted.current) setStatus(message || 'That did not save. Check the connection and try again.')
    } finally {
      if (mounted.current) setSavingId(null)
    }
  }

  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <h1 style={{ margin: 0 }}>Model corrections</h1>
      <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
        {showChecked ? 'Every model you have, busiest first.' : 'Models nobody has checked yet, busiest first.'} Turning one
        round or telling us to leave it alone takes a second and it stays fixed - no need to re-export anything.
      </p>
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: 'var(--text-sm)' }}>
        <input type="checkbox" checked={showChecked} onChange={(event) => setShowChecked(event.target.checked)} />
        <span>Show ones I have checked</span>
      </label>
      {problem && <p style={{ margin: 0, color: 'var(--color-danger)' }}>{problem}</p>}
      {status && <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }} role="status">{status}</p>}

      {loading ? (
        <p style={{ color: 'var(--color-text-secondary)' }}>Loading…</p>
      ) : models.length === 0 && !problem ? (
        <p style={{ color: 'var(--color-text-secondary)' }}>
          {/* "Everything has been looked at. Well done." was shown to a shop
              with no 3D models at all, because zero models means zero unchecked
              ones - a congratulation for work nobody had done. This list cannot
              tell the two apart while it is filtered, so the filtered message
              is one that is true either way. */}
          {showChecked ? 'No 3D models on the shop yet.' : 'Nothing here needs looking at.'}
        </p>
      ) : (
        <div className="table-wrapper">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th scope="col" align="left" style={cell}>Product</th>
                <th scope="col" align="right" style={cell}>Placed</th>
                <th scope="col" align="left" style={cell}>Turn it</th>
                <th scope="col" align="left" style={cell}>Leave detail alone</th>
                <th scope="col" align="left" style={cell}>Checked</th>
              </tr>
            </thead>
            <tbody>
              {models.map((entry) => {
                // Every row's controls sit out while any save is in flight - the
                // lock is global, and a control that silently does nothing is
                // worse than one that is plainly unavailable. Only the row being
                // saved says so, though: fifty buttons reading "Saving…" over one
                // save is its own kind of lie.
                const busy = savingId !== null
                const saving = savingId === entry.modelId
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
                      <div style={{ display: 'grid', gap: '0.1rem' }}>
                        <span>{entry.productName || 'Product no longer in the shop'}</span>
                        <code style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>{file}</code>
                      </div>
                    </td>
                    <td align="right" style={cell}>{entry.placements}</td>
                    <td style={cell}>
                      <div className="field" style={{ margin: 0 }}>
                        <select
                          aria-label={`Turn ${file}`}
                          value={String(entry.yawOffsetDegrees)}
                          disabled={busy}
                          onChange={(event) => void save(entry.modelId, { yawOffsetDegrees: Number(event.target.value) })}
                        >
                          {yawChoices.map((degrees) => (
                            <option key={degrees} value={degrees}>{degrees}°</option>
                          ))}
                        </select>
                      </div>
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
                      {entry.reviewed ? (
                        <span style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
                          <span className="badge badge-success">Checked</span>
                          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save(entry.modelId, { reviewed: false })}>
                            Mark unchecked
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="btn" disabled={busy} onClick={() => void save(entry.modelId, { reviewed: true })}>
                          {saving ? 'Saving…' : 'Mark checked'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && models.length >= MODEL_LIST_LIMIT && (
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          Showing the first {MODEL_LIST_LIMIT}, busiest first. There are more behind them.
        </p>
      )}
    </div>
  )
}

const cell: React.CSSProperties = { padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)' }
