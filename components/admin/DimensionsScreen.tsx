'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const cell: React.CSSProperties = { padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)' }

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
type CategoryDefault = { id: string; categoryId: string; categoryName: string; widthMm: number | null; depthMm: number | null; heightMm: number | null; mountType: string }
type MissingDefault = { categoryId: string; name: string; affected: number }
type Job = { id: string; status: string; cursor: number; total: number; resolvedCount: number; failedCount: number; error: string }
/** One modelled product, with a signed url good for this session. */
type MeasureWork = { productId: string; url: string; cacheKey: string; format: 'glb' | 'fbx' | 'obj'; yawOffsetDeg: number }
type MeasureState = { done: number; total: number; written: number; failed: number; conflicts: number; lost: number; implausible: number }

/** Files measured between cache clears. Keeps the tab's memory flat over a long pass. */
const MEASURE_CLEAR_EVERY = 8
/** Measurements per POST. Small enough that stopping loses almost nothing. */
const MEASURE_BATCH = 25
/** The route's own ceiling on one POST. It refuses a longer list outright rather
 * than trimming it, and one model file can answer for hundreds of products. */
const MEASURE_POST_MAX = 200
/** How many unreadable measurements the report hands back. The screen says so
 * rather than implying the list is the whole of it. */
const JUNK_LIST_LIMIT = 100

const SOURCE_LABELS: Record<string, string> = {
  glb: 'Measured from the 3D model',
  attribute: 'Read from the spec sheet',
  category_default: 'Typical for its category',
  manual: 'Typed in by hand',
  marker: 'No idea - shown as a plain block',
}

/** A rebuild's status in words the owner can act on. "cancelled" reads as
 * finished with, when in fact Start carries straight on from where it stopped. */
/** Everything a keyboard can land on inside the dialog. */
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

const JOB_STATUS_LABELS: Record<string, string> = {
  QUEUED: 'waiting to start',
  RUNNING: 'working',
  CANCELLED: 'stopped - press Start to carry on',
  DONE: 'finished',
  FAILED: 'stopped with a problem',
}

const MOUNT_LABELS: Record<string, string> = {
  floor: 'Stands on the floor',
  'desk-surface': 'Sits on a desk',
  'desk-edge-clamp': 'Clamps to a desk edge',
  wall: 'Hangs on the wall',
}

export function DimensionsScreen() {
  const [report, setReport] = useState<Report | null>(null)
  const [junk, setJunk] = useState<Junk[]>([])
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [defaults, setDefaults] = useState<CategoryDefault[]>([])
  const [missingDefaults, setMissingDefaults] = useState<MissingDefault[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [running, setRunning] = useState(false)
  const [measuring, setMeasuring] = useState(false)
  const [problem, setProblem] = useState('')
  const [measureState, setMeasure] = useState<MeasureState | null>(null)
  const cancelled = useRef(false)
  const measureCancelled = useRef(false)
  // The disabled buttons are a render behind the truth: two fast clicks on
  // Start both read running=false and two loops set off over the same job.
  // These refs are the truth the loops actually consult.
  const rebuildLive = useRef(false)
  const measureLive = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/m/space-planner-for-shop/admin/dimensions')
      if (!response.ok) throw new Error()
      const data = (await response.json()) as { report: Report; junk: Junk[]; conflicts: Conflict[]; defaults: CategoryDefault[]; missingDefaults: MissingDefault[]; job: Job | null }
      if (!mounted.current) return
      setReport(data.report)
      setJunk(data.junk)
      setConflicts(data.conflicts)
      setDefaults(data.defaults ?? [])
      setMissingDefaults(data.missingDefaults ?? [])
      setJob(data.job)
      setProblem('')
    } catch {
      if (mounted.current) setProblem('The size report would not load. Check the connection and refresh.')
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

  const rebuild = async () => {
    if (rebuildLive.current) return
    rebuildLive.current = true
    cancelled.current = false
    setRunning(true)
    setProblem('')
    // A refusal is not a network drop, and the "press Start to carry on"
    // message over one would have the owner pressing Start for ever.
    const refused = 'Your account can look but not rebuild the sizes - that needs the Space Planner manage permission.'
    // Set by ANY failure, not just a refusal. The refresh below clears the
    // message, so a red line explaining what went wrong flashed for one GET and
    // vanished - which is indistinguishable from nothing having happened.
    let wasRefused = false
    try {
      let current = job && (job.status === 'QUEUED' || job.status === 'RUNNING') ? job : null

      if (!current) {
        // Started with no job id, which the route reads as "carry on if there is
        // a stopped one, otherwise begin". Either way it answers with the job to
        // step, cursor and all.
        const response = await fetch('/api/m/space-planner-for-shop/admin/dimensions/rebuild', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        if (response.status === 403) {
          wasRefused = true
          if (mounted.current) setProblem(refused)
          return
        }
        if (!response.ok) throw new Error()
        const data = (await response.json()) as { job: Job }
        current = data.job
        if (mounted.current) setJob(current)
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
        if (response.status === 403) {
          wasRefused = true
          if (mounted.current) setProblem(refused)
          break
        }
        if (!response.ok) break
        const data = (await response.json()) as { job: Job | null; done: boolean }
        if (!data.job) break
        current = data.job
        if (mounted.current) setJob(current)
        if (data.done) break
      }
    } catch {
      // A network drop mid-run pauses the job rather than losing it - the
      // cursor is banked server-side - but the button has to come back, or the
      // screen sits on "Working…" for ever over a rebuild nothing is driving.
      wasRefused = true
      if (mounted.current) setProblem('The rebuild lost its connection. Press Start to carry on where it stopped.')
    } finally {
      rebuildLive.current = false
      if (mounted.current) {
        setRunning(false)
        // The refresh clears the message along with everything else, and after a
        // refusal the message is the only thing on the screen worth reading.
        // Nothing changed either, so there is nothing to refresh.
        if (!wasRefused) void load()
      }
    }
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
    if (measureLive.current) return
    measureLive.current = true
    measureCancelled.current = false
    setMeasuring(true)
    setProblem('')
    setMeasure({ done: 0, total: 0, written: 0, failed: 0, conflicts: 0, lost: 0, implausible: 0 })

    // Set by ANY failure, not just a refusal. The refresh below clears the
    // message, so a red line explaining what went wrong flashed for one GET and
    // vanished - which is indistinguishable from nothing having happened.
    let wasRefused = false
    try {
    // Imported here rather than at the top of the file so that opening this
    // screen does not pull three.js in behind it.
    const { clearPreparedModels, prepareModel } = await import('@/modules/space-planner-for-shop/lib/three/planner-model')

    const listing = await fetch('/api/m/space-planner-for-shop/admin/dimensions/measure')
    if (listing.status === 403) {
      wasRefused = true
      if (mounted.current) setProblem('Your account can look but not measure - that needs the Space Planner manage permission.')
      return
    }
    if (!listing.ok) {
      wasRefused = true
      if (mounted.current) setProblem('The list of models to measure would not load. Try again.')
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

    const batch: Array<{ productId: string; widthMm: number; depthMm: number; heightMm: number }> = []

    const post = async (slice: Array<{ productId: string; widthMm: number; depthMm: number; heightMm: number }>) => {
      const body = JSON.stringify({ measurements: slice })
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
          if (response.ok) {
            const result = (await response.json()) as { written: number; conflicts: number }
            totals.written += result.written
            totals.conflicts += result.conflicts
            return
          }
          // A refusal of this body is a refusal of this body. Sending the very
          // same list again gets the very same answer, so the retry is spent on
          // nothing and the loss is only counted a round later.
          if (response.status >= 400 && response.status < 500) break
        } catch {
          // Network hiccup - the retry above is the answer; falling out of the
          // loop below is the honest failure.
        }
      }
      totals.lost += slice.length
    }

    const flush = async () => {
      // Sliced to the route's ceiling, because a batch is grouped by FILE and one
      // file can answer for hundreds of products: a chair model shared by two
      // hundred and sixty-two of them arrived as a single over-long list, was
      // refused outright, and cost the same products their measurement on every
      // run thereafter.
      while (batch.length > 0) await post(batch.splice(0, MEASURE_POST_MAX))
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
      if (mounted.current) setMeasure({ ...totals })
    }

    await flush()
    clearPreparedModels()
    if (mounted.current) setMeasure({ ...totals })
    } catch {
      wasRefused = true
      if (mounted.current) setProblem('The measuring pass stopped early. Run it again - it re-measures cheaply and keeps what it banked.')
    } finally {
      measureLive.current = false
      if (mounted.current) {
        setMeasuring(false)
        // Nothing was written, and the refresh would take the refusal off the
        // screen with it.
        if (!wasRefused) void load()
      }
    }
  }

  const stopMeasuring = () => {
    measureCancelled.current = true
  }

  const stop = async () => {
    cancelled.current = true
    if (!job) return
    try {
      const response = await fetch(`/api/m/space-planner-for-shop/admin/dimensions/rebuild?jobId=${encodeURIComponent(job.id)}`, { method: 'DELETE' })
      if (response.status === 403) {
        // Stop is offered against any live job, including one another tab
        // started, so this account may well not be allowed to call it off.
        if (mounted.current) setProblem('Your account can look but not stop a rebuild - that needs the Space Planner manage permission.')
        return
      }
    } catch {
      // The loop above has already been told to stop; the job's cursor is banked
      // either way, and the next Start carries on from it.
    }
    void load()
  }

  const progress = job && job.total > 0 ? Math.min(100, Math.round((job.cursor / job.total) * 100)) : 0
  // A job left live by a closed tab is one nobody is driving. Stop has to reach
  // it, or reloading the page turns a pause into something that can be resumed
  // but never called off.
  const jobLive = job !== null && (job.status === 'QUEUED' || job.status === 'RUNNING')

  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <h1 style={{ margin: 0 }}>Sizes</h1>

      {problem && <p style={{ margin: 0, color: 'var(--color-danger)' }}>{problem}</p>}

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
          <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
            {report.total.toLocaleString('en-GB')} products have a size worked out. {report.missing.toLocaleString('en-GB')} have
            never been measured. {report.categoriesWithoutDefaults} categories have no fallback size, so anything in them with no
            spec sheet shows as a plain block.
          </p>
        </div>
      )}

      <FallbackSizesCard defaults={defaults} missing={missingDefaults} onChanged={() => void load()} />

      <div className="card" style={{ padding: '1rem', display: 'grid', gap: '0.6rem' }}>
        <h2 className="card-title" style={{ margin: 0 }}>Measure the 3D models</h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
          Opens every 3D model you have and measures it, so the planner uses the real thing rather than whatever the spec sheet
          says. Leave this tab open while it runs - it downloads each model to do it. Anything you have typed in by hand is left
          alone.
        </p>
        {measureState && (
          <div>
            {/* A bare div with a width was all this was: no role, no value, no
                name - on a pass the copy above tells the owner to sit and watch
                for an hour. */}
            <div
              role="progressbar"
              aria-label="Measuring 3D models"
              aria-valuemin={0}
              aria-valuemax={measureState.total}
              aria-valuenow={measureState.done}
              style={{ height: 8, background: 'var(--color-border)', borderRadius: 999, overflow: 'hidden' }}
            >
              <div
                style={{
                  width: `${measureState.total > 0 ? Math.round((measureState.done / measureState.total) * 100) : 0}%`,
                  height: '100%',
                  background: 'var(--color-primary)',
                }}
              />
            </div>
            <p role="status" aria-live="polite" style={{ margin: '0.35rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
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
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
          Goes through the whole catalogue. It takes a while and you can stop it at any point - it picks up where it left off.
        </p>
        {job && (
          <div>
            <div
              role="progressbar"
              aria-label="Working out sizes for the whole catalogue"
              aria-valuemin={0}
              aria-valuemax={job.total}
              aria-valuenow={job.cursor}
              style={{ height: 8, background: 'var(--color-border)', borderRadius: 999, overflow: 'hidden' }}
            >
              <div style={{ width: `${progress}%`, height: '100%', background: 'var(--color-primary)' }} />
            </div>
            <p role="status" aria-live="polite" style={{ margin: '0.35rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
              {job.cursor} of {job.total} · {JOB_STATUS_LABELS[job.status] ?? job.status.toLowerCase()}
              {job.failedCount > 0 && ` · ${job.failedCount} could not be read`}
              {job.error && ' · it stopped with a fault'}
            </p>
            {job.error && (
              <p style={{ margin: '0.15rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                {/* Kept, because the owner is the person who has to act on it -
                    but labelled as machine detail rather than dropped
                    mid-sentence into a progress readout as though it were
                    advice a human wrote. */}
                Technical detail, if you need to pass it on: {job.error}
              </p>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" className="btn btn-primary" onClick={() => void rebuild()} disabled={running || measuring}>
            {running ? 'Working…' : 'Start'}
          </button>
          <button type="button" className="btn" onClick={() => void stop()} disabled={!running && !jobLive}>
            Stop
          </button>
        </div>
      </div>

      {conflicts.length > 0 && (
        <div className="card" style={{ padding: '1rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem' }}>The 3D model and the spec sheet disagree</h2>
          <p style={{ margin: '0 0 0.5rem', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
            One of the two is wrong. Worth a look - this is how a room ends up full of furniture that is not the size it claims.
            {report && report.conflicts > conflicts.length
              ? ` Showing the first ${conflicts.length} of ${report.conflicts.toLocaleString('en-GB')}.`
              : ''}
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
          <p style={{ margin: '0 0 0.5rem', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
            The actual text, so you can fix it in the sheet. We would rather show a plain block than invent a size.
            {junk.length >= JUNK_LIST_LIMIT ? ` Showing the first ${JUNK_LIST_LIMIT} - fix these and the next lot appear.` : ''}
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

/**
 * The fallback size for a whole category - what a product in it shows as when
 * it has no better answer of its own.
 *
 * Categories with no fallback yet are listed worst-first, by how many products
 * are actually leaning on the gap right now - that is the ten minutes that pays
 * for itself soonest. Nothing here rewrites a product's own measurement: this
 * is rung three of the size ladder, under the spec sheet and the 3D model, and
 * only ever the answer when both of those have nothing to say.
 */
function FallbackSizesCard(props: { defaults: CategoryDefault[]; missing: MissingDefault[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<{ categoryId: string; categoryName: string } | null>(null)

  return (
    <div className="card" style={{ padding: '1rem', display: 'grid', gap: '0.6rem' }}>
      <h2 className="card-title" style={{ margin: 0 }}>Typical sizes, by category</h2>
      <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
        The size shown for a product with no spec-sheet measurement and no 3D model to measure - a plain block at roughly the
        right footprint, rather than nothing at all.
      </p>

      {props.missing.length > 0 && (
        <div>
          <p style={{ margin: '0 0 0.35rem', fontSize: 'var(--text-sm)', fontWeight: 600 }}>No fallback set yet</p>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.2rem' }}>
            {props.missing.map((entry) => (
              <li key={entry.categoryId} style={{ fontSize: 'var(--text-sm)' }}>
                {entry.name}{' '}
                {entry.affected > 0 && (
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    ({entry.affected} {entry.affected === 1 ? 'product showing' : 'products showing'} as a plain block)
                  </span>
                )}{' '}
                <button type="button" className="btn btn-sm" onClick={() => setEditing({ categoryId: entry.categoryId, categoryName: entry.name })}>
                  Set a size
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {props.defaults.length > 0 && (
        <div className="table-wrapper">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th scope="col" align="left" style={cell}>Category</th>
                <th scope="col" align="right" style={cell}>Width</th>
                <th scope="col" align="right" style={cell}>Depth</th>
                <th scope="col" align="right" style={cell}>Height</th>
                <th scope="col" align="left" style={cell}>How it sits</th>
                <th scope="col" style={cell} />
              </tr>
            </thead>
            <tbody>
              {props.defaults.map((entry) => (
                <tr key={entry.id}>
                  <td style={cell}>{entry.categoryName}</td>
                  <td align="right" style={cell}>{entry.widthMm ? `${entry.widthMm} mm` : '-'}</td>
                  <td align="right" style={cell}>{entry.depthMm ? `${entry.depthMm} mm` : '-'}</td>
                  <td align="right" style={cell}>{entry.heightMm ? `${entry.heightMm} mm` : '-'}</td>
                  <td style={cell}>{MOUNT_LABELS[entry.mountType] ?? entry.mountType}</td>
                  <td style={cell}>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing({ categoryId: entry.categoryId, categoryName: entry.categoryName })}>
                      Change
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {props.missing.length === 0 && props.defaults.length === 0 && (
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>No categories yet.</p>
      )}

      {editing && (
        <CategoryDefaultEditor
          categoryId={editing.categoryId}
          categoryName={editing.categoryName}
          current={props.defaults.find((entry) => entry.categoryId === editing.categoryId) ?? null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); props.onChanged() }}
        />
      )}
    </div>
  )
}

/** One category's fallback size, typed in and posted. A dialog rather than an
 * inline row of five fields, because setting one is a considered action - four
 * numbers and a mount type - not something to fat-finger between two other
 * clicks. */
function CategoryDefaultEditor(props: {
  categoryId: string
  categoryName: string
  current: CategoryDefault | null
  onClose: () => void
  onSaved: () => void
}) {
  const [widthMm, setWidthMm] = useState(String(props.current?.widthMm ?? ''))
  const [depthMm, setDepthMm] = useState(String(props.current?.depthMm ?? ''))
  const [heightMm, setHeightMm] = useState(String(props.current?.heightMm ?? ''))
  const [mountType, setMountType] = useState(props.current?.mountType ?? 'floor')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    const width = widthMm.trim() ? Number(widthMm) : null
    const depth = depthMm.trim() ? Number(depthMm) : null
    const height = heightMm.trim() ? Number(heightMm) : null
    for (const value of [width, depth, height]) {
      if (value !== null && (!Number.isFinite(value) || value < 1 || value > 20_000)) {
        setError('Sizes need to be between 1 and 20,000 mm, or left blank.')
        return
      }
    }
    // A fallback with nothing in it is not a fallback. It would answer no axis
    // and still make every product in the category read as "typical for its
    // category" rather than the honest plain block it is still shown as.
    if (width === null && depth === null && height === null) {
      setError('Give it at least one measurement, or remove the fallback instead.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const response = await fetch('/api/m/space-planner-for-shop/admin/dimensions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId: props.categoryId, widthMm: width, depthMm: depth, heightMm: height, mountType }),
      })
      if (response.status === 403) {
        setError('Your account can look but not change a fallback size - that needs the Space Planner manage permission.')
        return
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null
        setError(data?.error ?? 'That did not save. Try again.')
        return
      }
      props.onSaved()
    } catch {
      setError('That did not save. Check the connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    setSaving(true)
    setError('')
    try {
      const response = await fetch(`/api/m/space-planner-for-shop/admin/dimensions?categoryId=${encodeURIComponent(props.categoryId)}`, { method: 'DELETE' })
      if (response.status === 403) {
        setError('Your account can look but not remove a fallback size - that needs the Space Planner manage permission.')
        setSaving(false)
        return
      }
      if (!response.ok) throw new Error()
      props.onSaved()
    } catch {
      setError('That did not remove. Check the connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Typical size for ${props.categoryName}`}
      style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--color-text) 35%, transparent)', padding: '1rem', zIndex: 200 }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose() }}
      // It declared aria-modal and implemented none of it: no focus moved in, no
      // trap, no restore, and no Escape - the only way out was a backdrop click,
      // which throws away whatever has been typed without asking. The module's
      // own public planner has done all of this from the start.
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          props.onClose()
          return
        }
        if (event.key !== 'Tab') return
        const node = event.currentTarget
        const focusables = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (!first || !last) return
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
      ref={(node) => {
        if (!node || node.contains(document.activeElement)) return
        node.querySelector<HTMLElement>(FOCUSABLE)?.focus()
      }}
    >
      <div className="card" style={{ padding: '1rem', display: 'grid', gap: '0.6rem', width: 'min(24rem, 100%)' }}>
        <h3 style={{ margin: 0 }}>{props.categoryName}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.5rem' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="spl-default-width">Width (mm)</label>
            <input id="spl-default-width" inputMode="numeric" value={widthMm} onChange={(event) => setWidthMm(event.target.value)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="spl-default-depth">Depth (mm)</label>
            <input id="spl-default-depth" inputMode="numeric" value={depthMm} onChange={(event) => setDepthMm(event.target.value)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="spl-default-height">Height (mm)</label>
            <input id="spl-default-height" inputMode="numeric" value={heightMm} onChange={(event) => setHeightMm(event.target.value)} />
          </div>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="spl-default-mount">How it sits</label>
          <select id="spl-default-mount" value={mountType} onChange={(event) => setMountType(event.target.value)}>
            {Object.entries(MOUNT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        {error && <p style={{ margin: 0, color: 'var(--color-danger)', fontSize: 'var(--text-sm)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'space-between' }}>
          {props.current ? (
            <button type="button" className="btn btn-danger" disabled={saving} onClick={() => void remove()}>Remove</button>
          ) : <span />}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn" disabled={saving} onClick={props.onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
