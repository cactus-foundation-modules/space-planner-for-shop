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

/** What the detail endpoint answers with - enough to read a layout to a
 * customer over the telephone without opening their account. */
type Detail = {
  plan: { id: string; name: string; shareToken: string | null; quoteId: string | null; createdAt: string; updatedAt: string }
  room: { name: string; notes: string; geometry: { vertices: Array<{ x: number; y: number }>; ceilingMm: number; openings: unknown[]; obstructions: unknown[] } } | null
  bom: {
    lines: Array<{
      productId: string
      name: string
      sku: string
      quantity: number
      unitPriceFormatted: string
      lineTotalFormatted: string
      sizeLabel: string
      fromSnapshot: boolean
    }>
    itemCount: number
    totalFormatted: string
    missing: string[]
  }
}

/** Shoelace area in m² - the same figure the shopper's own header shows. */
function areaM2(vertices: Array<{ x: number; y: number }>): number {
  let sum = 0
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index]!
    const b = vertices[(index + 1) % vertices.length]!
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2 / 1_000_000
}

export function PlansScreen() {
  const [rows, setRows] = useState<Row[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [wanted, setWanted] = useState<Wanted[]>([])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState('')
  /** Which row is open, and what came back for it. Loading and failure travel
   * with the id so a slow detail never draws under the wrong row. */
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailProblem, setDetailProblem] = useState('')
  const [deleting, setDeleting] = useState(false)
  /** Two-step delete: first press arms it, second press does it. */
  const [confirmDelete, setConfirmDelete] = useState(false)
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

  /** Open a row, or close it if it is the one already open. */
  const toggleDetail = useCallback(async (planId: string) => {
    setConfirmDelete(false)
    if (openId === planId) {
      setOpenId(null)
      setDetail(null)
      setDetailProblem('')
      return
    }
    setOpenId(planId)
    setDetail(null)
    setDetailProblem('')
    try {
      const response = await fetch(`/api/m/space-planner-for-shop/admin/plans/${planId}`)
      if (!response.ok) throw new Error()
      const data = (await response.json()) as Detail
      // Only the row still open gets the answer - the person may have clicked
      // on through a slow network, and a layout drawn under the wrong customer
      // name is exactly the mistake this screen exists to prevent.
      setOpenId((currentOpen) => {
        if (currentOpen === planId) {
          setDetail(data)
          setDetailProblem('')
        }
        return currentOpen
      })
    } catch {
      setOpenId((currentOpen) => {
        if (currentOpen === planId) setDetailProblem('That layout would not load. Check the connection and try again.')
        return currentOpen
      })
    }
  }, [openId])

  const deletePlan = useCallback(async (planId: string) => {
    setDeleting(true)
    setDetailProblem('')
    try {
      const response = await fetch(`/api/m/space-planner-for-shop/admin/plans/${planId}`, { method: 'DELETE' })
      if (response.status === 403) {
        setDetailProblem('Your account can look but not delete - that needs the Space Planner manage permission.')
        return
      }
      if (!response.ok) throw new Error()
      setOpenId(null)
      setDetail(null)
      setConfirmDelete(false)
      void load(page, search)
    } catch {
      setDetailProblem('That did not delete. Check the connection and try again.')
    } finally {
      setDeleting(false)
    }
  }, [load, page, search])

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
          <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
            Customers keep putting these in rooms and we have no 3D model for them, so they show as plain blocks.
          </p>
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
            {wanted.map((entry) => (
              <li key={entry.productId}>
                {entry.name} <span style={{ color: 'var(--color-text-secondary)' }}>({entry.placements} placements)</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="field" style={{ margin: 0, maxWidth: '28rem' }}>
        <input
          aria-label="Search rooms and plans"
          placeholder="Search by customer, room or layout name"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {problem && (
        <p style={{ margin: 0, color: 'var(--color-danger)' }}>
          {problem}{' '}
          <button type="button" className="btn" onClick={() => void load(page, search)}>Try again</button>
        </p>
      )}

      {loading ? (
        <p style={{ color: 'var(--color-text-secondary)' }}>Loading…</p>
      ) : rows.length === 0 ? (
        !problem && <p style={{ color: 'var(--color-text-secondary)' }}>Nothing saved yet.</p>
      ) : (
        <div className="table-wrapper">
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
                <PlanRow
                  key={row.id}
                  row={row}
                  open={openId === row.id}
                  detail={openId === row.id ? detail : null}
                  problem={openId === row.id ? detailProblem : ''}
                  deleting={deleting}
                  confirmDelete={confirmDelete}
                  onToggle={() => void toggleDetail(row.id)}
                  onArmDelete={() => setConfirmDelete(true)}
                  onCancelDelete={() => setConfirmDelete(false)}
                  onDelete={() => void deletePlan(row.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > rows.length && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button type="button" className="btn" disabled={page <= 1} onClick={() => { const next = page - 1; setPage(next); void load(next, search) }}>
            Back
          </button>
          <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>Page {page} of {Math.ceil(total / 25)}</span>
          <button type="button" className="btn" disabled={page * 25 >= total} onClick={() => { const next = page + 1; setPage(next); void load(next, search) }}>
            More
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * One layout in the list, and everything about it when opened.
 *
 * The row itself is the button: the whole reason this screen exists is the
 * customer on the telephone, and "click the layout they name" beats a separate
 * View control nobody can see the point of. The expanded half is read-only bar
 * one action - delete, two presses apart, for the plan a customer asks to be
 * rid of (it is their data; GDPR requests land on the owner, not the member).
 */
function PlanRow(props: {
  row: Row
  open: boolean
  detail: Detail | null
  problem: string
  deleting: boolean
  confirmDelete: boolean
  onToggle: () => void
  onArmDelete: () => void
  onCancelDelete: () => void
  onDelete: () => void
}) {
  const { row, detail } = props
  return (
    <>
      <tr
        onClick={props.onToggle}
        style={{ cursor: 'pointer', background: props.open ? 'color-mix(in srgb, var(--color-primary) 7%, transparent)' : undefined }}
      >
        <Td>
          <button
            type="button"
            className="btn-link"
            aria-expanded={props.open}
            onClick={(event) => { event.stopPropagation(); props.onToggle() }}
          >
            {row.member}
          </button>
        </Td>
        <Td>{row.roomName}</Td>
        <Td>{row.name}</Td>
        <Td align="right">{row.itemCount}</Td>
        <Td>
          {row.quoted && <span className="badge badge-success">Quoted</span>}{' '}
          {row.shared && <span className="badge badge-info">Shared</span>}
        </Td>
        <Td>{new Date(row.updatedAt).toLocaleDateString('en-GB')}</Td>
      </tr>
      {props.open && (
        <tr>
          <td colSpan={6} style={{ padding: '0 0.5rem 0.75rem', borderBottom: '1px solid var(--color-border)' }}>
            {props.problem ? (
              <p style={{ margin: '0.5rem 0 0', color: 'var(--color-danger)' }}>{props.problem}</p>
            ) : !detail ? (
              <p style={{ margin: '0.5rem 0 0', color: 'var(--color-text-secondary)' }}>Loading…</p>
            ) : (
              <div className="card" style={{ padding: '0.75rem 1rem', marginTop: '0.5rem', display: 'grid', gap: '0.6rem' }}>
                <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                  {detail.room
                    ? <>Room <strong>{detail.room.name}</strong> · {areaM2(detail.room.geometry.vertices).toFixed(1)} m² · ceiling {(detail.room.geometry.ceilingMm / 1000).toFixed(2)} m · started {new Date(detail.plan.createdAt).toLocaleDateString('en-GB')} · last touched {new Date(detail.plan.updatedAt).toLocaleDateString('en-GB')}</>
                    : <>The room this layout belonged to has been deleted. · started {new Date(detail.plan.createdAt).toLocaleDateString('en-GB')}</>}
                </p>
                {detail.room?.notes ? (
                  <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Their notes: {detail.room.notes}</p>
                ) : null}
                {detail.bom.missing.length > 0 && (
                  <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-warning, var(--color-text))' }}>
                    No longer in the shop, priced as when they saved it: {detail.bom.missing.join(', ')}.
                  </p>
                )}
                {detail.bom.lines.length === 0 ? (
                  <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>Nothing placed in this layout yet.</p>
                ) : (
                  <div className="table-wrapper">
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                      <thead>
                        <tr>
                          <Th>Item</Th>
                          <Th>Size</Th>
                          <Th align="right">Qty</Th>
                          <Th align="right">Each</Th>
                          <Th align="right">Total</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.bom.lines.map((line) => (
                          <tr key={line.productId}>
                            <Td>
                              {line.name}
                              {line.sku ? <span style={{ color: 'var(--color-text-secondary)' }}> · {line.sku}</span> : null}
                              {line.fromSnapshot ? <span className="badge" style={{ marginLeft: '0.35rem' }}>No longer sold</span> : null}
                            </Td>
                            <Td>{line.sizeLabel}</Td>
                            <Td align="right">{line.quantity}</Td>
                            <Td align="right">{line.unitPriceFormatted}</Td>
                            <Td align="right">{line.lineTotalFormatted}</Td>
                          </tr>
                        ))}
                        <tr>
                          <Td><strong>Roughly</strong></Td>
                          <Td>{''}</Td>
                          <Td align="right"><strong>{detail.bom.itemCount}</strong></Td>
                          <Td align="right">{''}</Td>
                          <Td align="right"><strong>{detail.bom.totalFormatted}</strong></Td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  {props.confirmDelete ? (
                    <>
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-danger)' }}>
                        Really delete this layout? The customer loses it too.
                      </span>
                      <button type="button" className="btn btn-danger" disabled={props.deleting} onClick={props.onDelete}>
                        {props.deleting ? 'Deleting…' : 'Yes, delete it'}
                      </button>
                      {/* Once armed there was only "Yes, delete it": a
                          confirmation with no way to say no is not a
                          confirmation, and this one takes a customer's work
                          with it. */}
                      <button type="button" className="btn" disabled={props.deleting} onClick={props.onCancelDelete}>
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn" disabled={props.deleting} onClick={props.onArmDelete}>
                      Delete this layout
                    </button>
                  )}
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function Stat(props: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{props.value}</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{props.label}</div>
    </div>
  )
}

function Th(props: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th scope="col" align={props.align ?? 'left'} style={{ padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)', fontSize: 'var(--text-sm)' }}>
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
