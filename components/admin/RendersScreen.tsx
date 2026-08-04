'use client'

import { useEffect, useState } from 'react'

// The render log, with its errors in plain sight. A picture service that fails
// silently is one the owner hears about from a customer.

type Job = {
  id: string
  planId: string
  planName: string
  status: string
  resultUrl: string
  error: string
  createdAt: string
}

export function RendersScreen() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [configured, setConfigured] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      const response = await fetch('/api/m/space-planner-for-shop/admin/renders')
      if (response.ok) {
        const data = (await response.json()) as { jobs: Job[]; workerConfigured: boolean }
        setJobs(data.jobs)
        setConfigured(data.workerConfigured)
      }
      setLoading(false)
    })()
  }, [])

  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <h1 style={{ margin: 0 }}>Pictures</h1>

      {!configured && (
        <div className="card" style={{ padding: '1rem' }}>
          <strong>The picture service is not set up on this site.</strong>
          <p style={{ margin: '0.35rem 0 0', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
            Customers can still plan, print and get quotes - they just cannot ask for a photoreal picture of the finished
            room. Setting it up needs two settings adding to the site, which is a job for whoever looks after it.
          </p>
        </div>
      )}

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

const cell: React.CSSProperties = { padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)' }
