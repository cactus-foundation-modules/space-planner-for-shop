'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// The dimension report, the rebuild, and the measuring pass.
//
// The rebuild is driven from here, one bounded step at a time, because
// twenty-two thousand products will not resolve inside a sixty-second route -
// and a button that appears to hang is worse than no button. The owner watches a
// progress bar and can stop it, which is what makes it a job rather than a leap
// of faith.
//
// The measuring pass is driven from here for a harder reason: it can only run in
// a browser. Rung 1 of the size ladder says the mesh is truth where there is a
// mesh, and until this existed nothing ever wrote one of those rows, so a
// catalogue of properly modelled furniture was being sized off free-text spec
// columns. Loading a couple of hundred multi-megabyte models is not a request;
// this tab does it, with the same code that draws them in the planner, and posts
// the numbers back in batches.

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
/** One modelled product, with a signed url good for this session. */
type MeasureWork = { productId: string; url: string; cacheKey: string; format: 'glb' | 'fbx' | 'obj'; yawOffsetDeg: number }
type MeasureState = { done: number; total: number; written: number; failed: number; conflicts: number; lost: number; implausible: number }

/** Files measured between cache clears. Keeps the tab's memory flat over a long pass. */
const MEASURE_CLEAR_EVERY = 8
/** Measurements per POST. Small enough that stopping loses almost nothing. */
const MEASURE_BATCH = 25

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
  const [measuring, setMeasuring] = useState(false)
  const [measureState, setMeasure] = useState<MeasureState | null>(null)
  const cancelled = useRef(false)
  const measureCancelled = useRef(false)

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

  /**
   * Measure every modelled product in this tab and bank the results.
   *
   * Grouped by FILE, not by product: a chair range is one model shared by every
   * colour of it, and the measurement belongs to the file. Measuring per product
   * would parse the same forty megabytes eleven times over for eleven identical
   * answers.
   */
  const measureAll = async () => {
    measureCancelled.current = false
    setMeasuring(true)
    setMeasure({ done: 0, total: 0, written: 0, failed: 0, conflicts: 0, lost: 0, implausible: 0 })

    // Imported here rather than at the top of the file so that opening this
    // screen does not pull three.js in behind it.
    const { clearPreparedModels, prepareModel } = await import('@/modules/space-planner-for-shop/lib/three/planner-model')

    const listing = await fetch('/api/m/space-planner-for-shop/admin/dimensions/measure')
    if (!listing.ok) {
      setMeasuring(false)
      return
    }
    const { models } = (await listing.json()) as { models: MeasureWork[] }

    // One entry per file, carrying every product that file answers for.
    const files = new Map<string, { work: MeasureWork; productIds: string[] }>()
    for (const work of models) {
      const key = `${work.cacheKey}|${work.yawOffsetDeg}`
      const existing = files.get(key)
      if (existing) existing.productIds.push(work.productId)
      else files.set(key, { work, productIds: [work.productId] })
    }

    const totals: MeasureState = { done: 0, total: files.size, written: 0, failed: 0, conflicts: 0, lost: 0, implausible: 0 }
    setMeasure({ ...totals })

    let batch: Array<{ productId: string; widthMm: number; depthMm: number; heightMm: number }> = []
    const flush = async () => {
      if (batch.length === 0) return
      const body = JSON.stringify({ measurements: batch })
      const size = batch.length
      batch = []
      // One retry, then COUNT the loss. This used to drop a failed batch on the
      // floor without a word, which is how a pass could end "written 9,962" out
      // of eleven and a half thousand while reporting nothing wrong.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetch('/api/m/space-planner-for-shop/admin/dimensions/measure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
          if (!response.ok) continue
          const result = (await response.json()) as { written: number; conflicts: number }
          totals.written += result.written
          totals.conflicts += result.conflicts
          return
        } catch {
          // Network hiccup - the retry above is the answer; falling out of the
          // loop below is the honest failure.
        }
      }
      totals.lost += size
    }

    for (const entry of files.values()) {
      if (measureCancelled.current) break
      try {
        const ready = await prepareModel(entry.work.cacheKey, entry.work.url, entry.work.format, {
          yawOffsetDeg: entry.work.yawOffsetDeg,
          // Nothing here is drawn, so nothing here is worth simplifying or
          // shrinking - and a decimated mesh is not the mesh being measured.
          noDecimation: true,
          decimationTarget: 1,
          textureMaxPx: 64,
        })
        // Filtered HERE, not left to the route: the route's validation rejects
        // a whole batch over one bad number, so a single mesh measuring NaN or
        // forty metres (a file exported in centimetres) silently cost every
        // other product in its batch - the same products, every run.
        const plausible = [ready.widthMm, ready.depthMm, ready.heightMm].every(
          (mm) => Number.isFinite(mm) && mm >= 5 && mm <= 20_000,
        )
        if (!plausible) {
          totals.implausible += entry.productIds.length
        } else {
          for (const productId of entry.productIds) {
            batch.push({ productId, widthMm: ready.widthMm, depthMm: ready.depthMm, heightMm: ready.heightMm })
          }
        }
      } catch {
        totals.failed += 1
      }

      totals.done += 1
      if (batch.length >= MEASURE_BATCH) await flush()
      // The prepared-model cache exists to make a ROOM cheap; over a whole
      // catalogue it is just a leak with a nice name.
      if (totals.done % MEASURE_CLEAR_EVERY === 0) clearPreparedModels()
      setMeasure({ ...totals })
    }

    await flush()
    clearPreparedModels()
    setMeasure({ ...totals })
    setMeasuring(false)
    void load()
  }

  const stopMeasuring = () => {
    measureCancelled.current = true
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
        <h2 className="card-title" style={{ margin: 0 }}>Measure the 3D models</h2>
        <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
          Opens every 3D model you have and measures it, so the planner uses the real thing rather than whatever the spec sheet
          says. Leave this tab open while it runs - it downloads each model to do it. Anything you have typed in by hand is left
          alone.
        </p>
        {measureState && (
          <div>
            <div style={{ height: 8, background: 'var(--color-border)', borderRadius: 999, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${measureState.total > 0 ? Math.round((measureState.done / measureState.total) * 100) : 0}%`,
                  height: '100%',
                  background: 'var(--color-primary)',
                }}
              />
            </div>
            <p style={{ margin: '0.35rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
              {measureState.done} of {measureState.total} models · {measureState.written} sizes saved
              {measureState.failed > 0 && ` · ${measureState.failed} would not open`}
              {measureState.lost > 0 && ` · ${measureState.lost} could not be saved - run it again`}
              {measureState.implausible > 0 && ` · ${measureState.implausible} measured an impossible size (wrong unit in the file?) - not saved`}
              {measureState.conflicts > 0 && ` · ${measureState.conflicts} disagree with the spec sheet`}
            </p>
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" className="btn btn-primary" onClick={() => void measureAll()} disabled={measuring || running}>
            {measuring ? 'Measuring…' : 'Measure'}
          </button>
          <button type="button" className="btn" onClick={stopMeasuring} disabled={!measuring}>
            Stop
          </button>
        </div>
      </div>

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
          <button type="button" className="btn btn-primary" onClick={() => void rebuild()} disabled={running || measuring}>
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
