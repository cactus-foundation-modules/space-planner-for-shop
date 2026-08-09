'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Rooms & plans.
//
// This screen earns its place the moment a customer rings up about a layout they
// saved - which is the actual reason it exists. The numbers beside it are the
// reason the owner keeps paying for 3D models.

type Row = {
  id: string
  name: string
  roomName: string
  member: string
  itemCount: number
  quoted: boolean
  shared: boolean
  updatedAt: string
}

type Summary = { plansThisWeek: number; roomsThisWeek: number; quotesThisWeek: number; cartHandoffsThisWeek: number; openedThisWeek: number }
type Wanted = { productId: string; name: string; placements: number }

export function PlansScreen() {
  const [rows, setRows] = useState<Row[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [wanted, setWanted] = useState<Wanted[]>([])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState('')
  // Only the latest request writes: typing and paging overlap, and responses
  // come back in whatever order the network pleases. Doubles as the unmount
  // guard - the cleanup bumps it, and a fetch that lands afterwards is stale by
  // definition.
  const requestSeq = useRef(0)
  useEffect(() => () => { requestSeq.current += 1 }, [])

  const load = useCallback(async (nextPage: number, term: string) => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(nextPage), withInsights: '1' })
      if (term) params.set('search', term)
      const response = await fetch(`/api/m/space-planner-for-shop/admin/plans?${params.toString()}`)
      if (!response.ok) throw new Error()
      const data = (await response.json()) as { rows: Row[]; total: number; summary: Summary; wanted: Wanted[] }
      if (seq !== requestSeq.current) return
      setRows(data.rows)
      setTotal(data.total)
      setSummary(data.summary)
      setWanted(data.wanted)
      setProblem('')
    } catch {
      // A screen that shows "Nothing saved yet" over a network error tells the
      // owner their customers' work has vanished. Say what actually happened.
      if (seq === requestSeq.current) setProblem('The list would not load. Check the connection and try again.')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => { setPage(1); void load(1, search) }, 250)
    return () => clearTimeout(timer)
  }, [search, load])

  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <h1 style={{ margin: 0 }}>Rooms &amp; plans</h1>

      {summary && (
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
          <Stat label="Opened this week" value={summary.openedThisWeek} />
          <Stat label="Rooms drawn" value={summary.roomsThisWeek} />
          <Stat label="Plans saved" value={summary.plansThisWeek} />
          <Stat label="Sent to the basket" value={summary.cartHandoffsThisWeek} />
          <Stat label="Quotes asked for" value={summary.quotesThisWeek} />
        </div>
      )}

      {wanted.length > 0 && (
        <div className="card" style={{ padding: '1rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem' }}>Worth getting modelled</h2>
          <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
            Customers keep putting these in rooms and we have no 3D model for them, so they show as plain blocks.
          </p>
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
            {wanted.map((entry) => (
              <li key={entry.productId}>
                {entry.name} <span style={{ color: 'var(--color-text-muted)' }}>({entry.placements} placements)</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <input
        className="form-input"
        placeholder="Search by customer, room or layout name"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        style={{ maxWidth: '28rem' }}
      />

      {problem && (
        <p style={{ margin: 0, color: 'var(--color-danger)' }}>
          {problem}{' '}
          <button type="button" className="btn" onClick={() => void load(page, search)}>Try again</button>
        </p>
      )}

      {loading ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
      ) : rows.length === 0 ? (
        !problem && <p style={{ color: 'var(--color-text-muted)' }}>Nothing saved yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <Th>Customer</Th>
              <Th>Room</Th>
              <Th>Layout</Th>
              <Th align="right">Items</Th>
              <Th>Status</Th>
              <Th>Last edited</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <Td>{row.member}</Td>
                <Td>{row.roomName}</Td>
                <Td>{row.name}</Td>
                <Td align="right">{row.itemCount}</Td>
                <Td>
                  {row.quoted && <span className="badge badge-success">Quoted</span>}{' '}
                  {row.shared && <span className="badge">Shared</span>}
                </Td>
                <Td>{new Date(row.updatedAt).toLocaleDateString('en-GB')}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {total > rows.length && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button type="button" className="btn" disabled={page <= 1} onClick={() => { const next = page - 1; setPage(next); void load(next, search) }}>
            Back
          </button>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>Page {page} of {Math.ceil(total / 25)}</span>
          <button type="button" className="btn" disabled={page * 25 >= total} onClick={() => { const next = page + 1; setPage(next); void load(next, search) }}>
            More
          </button>
        </div>
      )}
    </div>
  )
}

function Stat(props: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{props.value}</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{props.label}</div>
    </div>
  )
}

function Th(props: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th align={props.align ?? 'left'} style={{ padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)', fontSize: 'var(--text-sm)' }}>
      {props.children}
    </th>
  )
}

function Td(props: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td align={props.align ?? 'left'} style={{ padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)' }}>
      {props.children}
    </td>
  )
}
