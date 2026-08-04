'use client'

import { useCallback, useEffect, useState } from 'react'

// Model corrections.
//
// A worst-offenders view rather than an index: models nobody has looked at,
// most-placed first. Ten minutes here pointed at the twelve models customers
// actually use is worth a great deal; the same ten minutes spent alphabetically
// is worth nothing.

type Entry = { modelId: string; productId: string; url: string; format: string; placements: number }

export function ModelsScreen() {
  const [models, setModels] = useState<Entry[]>([])
  const [status, setStatus] = useState('')

  const load = useCallback(async () => {
    const response = await fetch('/api/m/space-planner-for-shop/admin/models')
    if (!response.ok) return
    const data = (await response.json()) as { models: Entry[] }
    setModels(data.models)
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
    setStatus('Saving…')
    const response = await fetch('/api/m/space-planner-for-shop/admin/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'file', modelId, ...patch }),
    })
    setStatus(response.ok ? 'Saved.' : 'That did not save.')
    if (response.ok) void load()
  }

  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <h1 style={{ margin: 0 }}>Model corrections</h1>
      <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
        Models nobody has checked yet, busiest first. Turning one round or telling us to leave it alone takes a second and
        it stays fixed - no need to re-export anything.
      </p>
      {status && <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{status}</p>}

      {models.length === 0 ? (
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
            {models.map((entry) => (
              <tr key={entry.modelId}>
                <td style={cell}>
                  <code style={{ fontSize: 'var(--text-xs)' }}>{entry.url.split('/').pop()?.split('?')[0]}</code>
                </td>
                <td align="right" style={cell}>{entry.placements}</td>
                <td style={cell}>
                  <select
                    className="form-input"
                    defaultValue="0"
                    onChange={(event) => void save(entry.modelId, { yawOffsetDegrees: Number(event.target.value) })}
                  >
                    {[0, 90, 180, 270].map((degrees) => (
                      <option key={degrees} value={degrees}>{degrees}°</option>
                    ))}
                  </select>
                </td>
                <td style={cell}>
                  <input type="checkbox" onChange={(event) => void save(entry.modelId, { noDecimation: event.target.checked })} />
                </td>
                <td style={cell}>
                  <button type="button" className="btn" onClick={() => void save(entry.modelId, { reviewed: true })}>
                    Mark checked
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

const cell: React.CSSProperties = { padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)' }
