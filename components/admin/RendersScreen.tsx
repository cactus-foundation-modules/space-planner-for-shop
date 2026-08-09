'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// The render log, with its errors in plain sight, and the switch that turns the
// whole thing on.
//
// Setting up used to mean two environment variables and a machine somebody built
// by hand, which is a fine answer for people who run their own infrastructure
// and no answer at all for everybody else. So: if the site already has a Fly.io
// key - and it usually does, because the video converter wanted one first - this
// is one button. If it does not, it is one box and one button.

type Job = {
  id: string
  planId: string
  planName: string
  status: string
  resultUrl: string
  error: string
  createdAt: string
}

type WorkerView = {
  configured: boolean
  tokenSource: 'own' | 'media' | 'env' | null
  appName: string | null
  region: string
  image: string
  external: boolean
  liveMachines: number
  error: string | null
  envOverride: boolean
}

export function RendersScreen() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [worker, setWorker] = useState<WorkerView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const load = useCallback(async () => {
    try {
      const [jobsRes, workerRes] = await Promise.all([
        fetch('/api/m/space-planner-for-shop/admin/renders'),
        fetch('/api/m/space-planner-for-shop/admin/render-worker'),
      ])
      if (!mounted.current) return
      if (jobsRes.ok) {
        const data = (await jobsRes.json()) as { jobs: Job[] }
        if (mounted.current) setJobs(data.jobs)
      }
      if (workerRes.ok && mounted.current) setWorker((await workerRes.json()) as WorkerView)
      if (!jobsRes.ok && !workerRes.ok) setProblem('This screen would not load. Check the connection and refresh.')
    } catch {
      if (mounted.current) setProblem('This screen would not load. Check the connection and refresh.')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await load()
    })()
  }, [load])

  // While a picture is being made the log keeps itself current, so the owner
  // watching one is not left pressing refresh to find out how it went.
  const anyLive = jobs.some((job) => job.status === 'QUEUED' || job.status === 'RUNNING')
  useEffect(() => {
    if (!anyLive) return
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [anyLive, load])

  const setUp = async () => {
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      const response = await fetch('/api/m/space-planner-for-shop/admin/render-worker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(token.trim() ? { token: token.trim() } : {}),
      })
      const data = (await response.json().catch(() => null)) as (WorkerView & { error?: string }) | null
      if (!mounted.current) return
      if (!response.ok) {
        setProblem(data?.error ?? 'That did not work.')
      } else if (data) {
        setWorker(data)
        setToken('')
        setNotice('All set. Nothing is running yet - a machine is made when somebody asks for a picture, and it puts itself away afterwards.')
      }
    } catch {
      // Without this, a network drop left the button saying "Building it…"
      // for ever over a service that may or may not exist.
      if (mounted.current) setProblem('We lost the connection while setting up. Refresh to see whether it finished.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const takeDown = async () => {
    if (!window.confirm('Take the picture service down? Existing pictures stay where they are; new ones stop being possible until you set it up again.')) return
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      const response = await fetch('/api/m/space-planner-for-shop/admin/render-worker', { method: 'DELETE' })
      const data = (await response.json().catch(() => null)) as (WorkerView & { warning?: string }) | null
      if (!mounted.current) return
      if (data) setWorker(data)
      if (data?.warning) setProblem(data.warning)
      else setNotice('Taken down.')
    } catch {
      if (mounted.current) setProblem('We lost the connection while taking it down. Refresh to see where it got to.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
        <h1 style={{ margin: 0 }}>Pictures</h1>
        <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      {worker && <SetUpCard worker={worker} token={token} setToken={setToken} onSetUp={setUp} onTakeDown={takeDown} busy={busy} />}

      {notice && <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>{notice}</p>}
      {problem && <p style={{ margin: 0, color: 'var(--color-danger, #b3261e)' }}>{problem}</p>}

      {loading ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
      ) : jobs.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Nobody has asked for one yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left" style={cell}>Layout</th>
              <th align="left" style={cell}>Asked for</th>
              <th align="left" style={cell}>How it went</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td style={cell}>{job.planName}</td>
                <td style={cell}>{new Date(job.createdAt).toLocaleString('en-GB')}</td>
                <td style={cell}>
                  {job.status === 'DONE' && job.resultUrl ? (
                    <a href={job.resultUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>
                      Have a look
                    </a>
                  ) : job.status === 'FAILED' ? (
                    <span style={{ color: 'var(--color-danger, #b3261e)' }}>{job.error || 'Failed'}</span>
                  ) : (
                    job.status.toLowerCase()
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function SetUpCard(props: {
  worker: WorkerView
  token: string
  setToken: (value: string) => void
  onSetUp: () => void
  onTakeDown: () => void
  busy: boolean
}) {
  const { worker } = props

  // Somebody has pointed this site at a worker they run themselves. Nothing here
  // applies, and quietly offering to build a second one would be rude.
  if (worker.envOverride) {
    return (
      <div className="card" style={{ padding: '1rem', display: 'grid', gap: '0.35rem' }}>
        <strong>Pictures are on, using your own picture service.</strong>
        <span style={muted}>
          This site is pointed at a machine you run yourself, so there is nothing to set up here and nothing for us to bill
          you for.
        </span>
      </div>
    )
  }

  if (worker.configured) {
    return (
      <div className="card" style={{ padding: '1rem', display: 'grid', gap: '0.5rem' }}>
        <strong>Pictures are on.</strong>
        <span style={muted}>
          {worker.liveMachines === 0
            ? 'Nothing is running at the moment, which is exactly right - a machine is made when somebody asks for a picture and puts itself away as soon as it is done.'
            : `${worker.liveMachines} ${worker.liveMachines === 1 ? 'picture is' : 'pictures are'} being made right now.`}
        </span>
        {worker.error && <span style={{ color: 'var(--color-danger, #b3261e)' }}>{worker.error}</span>}
        <div>
          <button type="button" className="btn btn-secondary" onClick={props.onTakeDown} disabled={props.busy}>
            {props.busy ? 'Working…' : 'Take it down'}
          </button>
        </div>
      </div>
    )
  }

  const borrowed = worker.tokenSource === 'media' || worker.tokenSource === 'env'

  return (
    <div className="card" style={{ padding: '1rem', display: 'grid', gap: '0.6rem' }}>
      <strong>Photoreal pictures are not switched on yet.</strong>
      <span style={muted}>
        Customers can still plan, print and get quotes - they just cannot ask for a photoreal picture of the finished room.
      </span>

      {borrowed ? (
        <span style={muted}>
          Good news: this site already has a Fly.io key set up{worker.tokenSource === 'media' ? ' for the video converter' : ''}, so
          there is nothing to type in. Press the button and we will build the picture service for you. Nothing runs - and
          nothing costs - until somebody actually asks for a picture.
        </span>
      ) : (
        <>
          <span style={muted}>
            Pictures are made on a machine that only exists while it is drawing one. To build it we need a Fly.io key with
            permission to make apps - an organisation key, from the Tokens page of your Fly.io dashboard.
          </span>
          <label htmlFor="spl-fly-token" style={{ fontSize: 'var(--text-sm, 0.875rem)', fontWeight: 600 }}>
            Fly.io API key
          </label>
          <input
            id="spl-fly-token"
            type="password"
            value={props.token}
            onChange={(event) => props.setToken(event.target.value)}
            placeholder="Paste a Fly.io organisation key"
            autoComplete="off"
            style={{
              padding: '0.5rem 0.6rem',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm, 6px)',
              background: 'var(--color-surface)',
              color: 'var(--color-text)',
            }}
          />
        </>
      )}

      <div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={props.onSetUp}
          disabled={props.busy || (!borrowed && !props.token.trim())}
        >
          {props.busy ? 'Building it…' : 'Set up the picture service'}
        </button>
      </div>
    </div>
  )
}

const cell: React.CSSProperties = { padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)' }
const muted: React.CSSProperties = { color: 'var(--color-text-muted)', fontSize: 'var(--text-sm, 0.875rem)' }
