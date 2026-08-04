'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// The dimension report, and the rebuild.
//
// The rebuild is driven from here, one bounded step at a time, because
// twenty-two thousand products will not resolve inside a sixty-second route -
// and a button that appears to hang is worse than no button. The owner watches a
// progress bar and can stop it, which is what makes it a job rather than a leap
// of faith.

type Report = {
  total: number
  bySource: Record<string, number>
  conflicts: number
  missing: number
  categoriesWithoutDefaults: number
}
type Junk = { productId: string; name: string; parsedFrom: string; source: string }
type Conflict = { productId: string; name: string; note: string }
type Job = { id: string; status: string; cursor: number; total: number; resolvedCount: number; failedCount: number; error: string }

const SOURCE_LABELS: Record<string, string> = {
  glb: 'Measured from the 3D model',
  attribute: 'Read from the spec sheet',
  category_default: 'Typical for its category',
  manual: 'Typed in by hand',
  marker: 'No idea - shown as a plain block',
}

export function DimensionsScreen() {
  const [report, setReport] = useState<Report | null>(null)
  const [junk, setJunk] = useState<Junk[]>([])
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [running, setRunning] = useState(false)
  const cancelled = useRef(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/m/space-planner-for-shop/admin/dimensions')
    if (!response.ok) return
    const data = (await response.json()) as { report: Report; junk: Junk[]; conflicts: Conflict[]; job: Job | null }
    setReport(data.report)
    setJunk(data.junk)
    setConflicts(data.conflicts)
    setJob(data.job)
  }, [])

  useEffect(() => {
    // Awaited inside the effect rather than fired off through the shared
    // loader, so the state updates land after the first paint instead of
    // cascading a second render out of the first one.
    void (async () => {
      await load()
    })()
  }, [load])

  const rebuild = async () => {
    cancelled.current = false
    setRunning(true)
    let current = job && (job.status === 'QUEUED' || job.status === 'RUNNING') ? job : null

    if (!current) {
      const response = await fetch('/api/m/space-planner-for-shop/admin/dimensions/rebuild', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const data = (await response.json()) as { job: Job }
      current = data.job
      setJob(current)
    }

    // The loop is here rather than on the server on purpose: each call is one
    // bounded step that banks its cursor, so a closed tab pauses the rebuild
    // rather than losing it.
    while (current && !cancelled.current) {
      const response = await fetch('/api/m/space-planner-for-shop/admin/dimensions/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: current.id }),
      })
      if (!response.ok) break
      const data = (await response.json()) as { job: Job | null; done: boolean }
      if (!data.job) break
      current = data.job
      setJob(current)
      if (data.done) break
    }

    setRunning(false)
    void load()
  }

  const stop = async () => {
    cancelled.current = true
    if (!job) return
    await fetch(`/api/m/space-planner-for-shop/admin/dimensions/rebuild?jobId=${encodeURIComponent(job.id)}`, { method: 'DELETE' })
    void load()
  }

  const progress = job && job.total > 0 ? Math.min(100, Math.round((job.cursor / job.total) * 100)) : 0

  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <h1 style={{ margin: 0 }}>Sizes</h1>

      {report && (
        <div className="card" style={{ padding: '1rem', display: 'grid', gap: '0.5rem' }}>
          <h2 className="card-title" style={{ margin: 0 }}>Where the measurements come from</h2>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {Object.entries(report.bySource).map(([source, count]) => (
              <li key={source}>
                {SOURCE_LABELS[source] ?? source}: <strong>{count}</strong>
              </li>
            ))}
          </ul>
          <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
            {report.missing} products have never been measured. {report.categoriesWithoutDefaults} categories have no fallback size,
            so anything in them with no spec sheet shows as a plain block.
          </p>
        </div>
      )}

      <div className="card" style={{ padding: '1rem', display: 'grid', gap: '0.6rem' }}>
        <h2 className="card-title" style={{ margin: 0 }}>Work the sizes out again</h2>
        <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
          Goes through the whole catalogue. It takes a while and you can stop it at any point - it picks up where it left off.
        </p>
        {job && (
          <div>
            <div style={{ height: 8, background: 'var(--color-border)', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{ width: `${progress}%`, height: '100%', background: 'var(--color-primary)' }} />
            </div>
            <p style={{ margin: '0.35rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
              {job.cursor} of {job.total} · {job.status.toLowerCase()}
              {job.failedCount > 0 && ` · ${job.failedCount} could not be read`}
              {job.error && ` · ${job.error}`}
            </p>
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" className="btn btn-primary" onClick={() => void rebuild()} disabled={running}>
            {running ? 'Working…' : 'Start'}
          </button>
          <button type="button" className="btn" onClick={() => void stop()} disabled={!running}>
            Stop
          </button>
        </div>
      </div>

      {conflicts.length > 0 && (
        <div className="card" style={{ padding: '1rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem' }}>The 3D model and the spec sheet disagree</h2>
          <p style={{ margin: '0 0 0.5rem', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
            One of the two is wrong. Worth a look - this is how a room ends up full of furniture that is not the size it claims.
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {conflicts.map((entry) => (
              <li key={entry.productId}>
                <strong>{entry.name}</strong> - {entry.note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {junk.length > 0 && (
        <div className="card" style={{ padding: '1rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem' }}>Measurements we could not read</h2>
          <p style={{ margin: '0 0 0.5rem', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
            The actual text, so you can fix it in the sheet. We would rather show a plain block than invent a size.
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {junk.map((entry) => (
              <li key={entry.productId}>
                <strong>{entry.name}</strong> - <code>{entry.parsedFrom}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
