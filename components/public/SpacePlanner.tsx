'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'
import { formatMoney } from '@/modules/shop/lib/money'
import { CataloguePanel } from '@/modules/space-planner-for-shop/components/public/CataloguePanel'
import { Plan2d } from '@/modules/space-planner-for-shop/components/public/Plan2d'
import { plannerCss } from '@/modules/space-planner-for-shop/components/public/planner-css'
import { addPlanToCart, cartAsStagedItems } from '@/modules/space-planner-for-shop/lib/client/cart-bridge'
import { clearScratch, readScratch, writeScratch } from '@/modules/space-planner-for-shop/lib/client/scratch'
import {
  emptyState,
  findClashes,
  findFreeSpot,
  plannerReducer,
  pushHistory,
  redo,
  toPlanItems,
  undo,
} from '@/modules/space-planner-for-shop/lib/client/planner-store'
import type { History, PlannerState, ProductSize } from '@/modules/space-planner-for-shop/lib/client/planner-store'
import { buildScene } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { ResolvedModel } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import { polygonAreaM2 } from '@/modules/space-planner-for-shop/lib/geometry'
import { formatLength, parseLengthMm } from '@/modules/space-planner-for-shop/lib/units'
import { defaultRoomGeometry } from '@/modules/space-planner-for-shop/lib/types'
import type { PlanItem, ProductSnapshot, RoomGeometry } from '@/modules/space-planner-for-shop/lib/types'
import type { CatalogueCard } from '@/modules/space-planner-for-shop/lib/catalogue'

// The planner.
//
// Everything the shopper touches, in one client component that owns the state
// and hands it down. The 3D view is loaded on demand so the flat plan - which is
// the primary surface and works without WebGL - costs nothing extra, and a page
// merely carrying the teaser block never pulls three.js at all.
//
// The shell is an application rather than a document: a toolbar, a workspace of
// a definite height, and two panes that scroll themselves. See planner-css.ts
// for why the definite height is load-bearing rather than decorative.

const View3d = dynamic(() => import('@/modules/space-planner-for-shop/components/public/View3d').then((m) => m.View3d), {
  ssr: false,
  loading: () => <div className="spl-coach">Loading the 3D view…</div>,
})

type ProductInfo = ProductSize & { name: string; image: string | null; priceFormatted: string; price: number }

export type SpacePlannerProps = {
  signedIn: boolean
  signInHref: string
  heading: string
  intro: string
  budgets: { maxUniqueModels: number; decimationTarget: number; textureMaxPx: number; decimationEnabled: boolean }
  guidance: { walkwayClearanceMm: number; disclaimer: string; enabled: boolean }
  /** Whatever this shop prints in front of a number. Never assumed to be a pound. */
  currencySymbol: string
  /** Staged straight from the basket when the shopper arrived from the cart. */
  stageCart: boolean
  /** Pre-staged single product when they arrived from a product page. */
  stageProductId?: string | null
}

type Tab = 'catalogue' | 'selected' | 'items'
type StageView = 'plan' | 'orbit' | 'eye'

const VIEW_LABELS: Record<StageView, string> = { plan: 'Flat plan', orbit: '3D', eye: 'Stand in it' }
const TAB_LABELS: Record<Tab, string> = { catalogue: 'Add things', selected: 'Selected', items: 'Item list' }

export function SpacePlanner(props: SpacePlannerProps) {
  const [state, dispatch] = useReducer(plannerReducer, undefined, () => emptyState(defaultRoomGeometry()))
  const [history, setHistory] = useState<History>({ past: [], future: [] })
  const [started, setStarted] = useState(false)
  const [tab, setTab] = useState<Tab>('catalogue')
  const [stage, setStage] = useState<StageView>('plan')
  const [products, setProducts] = useState<Record<string, ProductInfo>>({})
  const [models, setModels] = useState<Map<string, { url: string; cacheKey: string; format: string }>>(new Map())
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [savedPlanId, setSavedPlanId] = useState<string | null>(null)
  const [savedRoomId, setSavedRoomId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [wallEdit, setWallEdit] = useState<{ index: number; lengthMm: number } | null>(null)
  const [roomEdit, setRoomEdit] = useState(false)
  const idCounter = useRef(0)
  const stagedProductRef = useRef(false)

  const nextId = useCallback(() => {
    idCounter.current += 1
    return `i${Date.now().toString(36)}${idCounter.current}`
  }, [])

  const commit = useCallback(() => {
    setHistory((current) => pushHistory(current, state))
    setDirty(true)
  }, [state])

  // ---- first run --------------------------------------------------------

  useEffect(() => {
    // Restoring what a signed-out visitor was in the middle of. It has to be an
    // effect rather than a lazy initial state: localStorage does not exist while
    // this renders on the server, and reading it during the first client render
    // would hand back different markup than the server sent. Deferred by a
    // microtask so the restore lands as its own update rather than cascading out
    // of the first paint.
    const scratch = readScratch()
    if (!scratch) return
    queueMicrotask(() => {
      dispatch({ type: 'load', snapshot: { geometry: scratch.geometry, items: scratch.items } })
      setStarted(true)
    })
  }, [])

  // ---- product data -----------------------------------------------------

  const productIds = useMemo(() => [...new Set(state.items.map((item) => item.productId))], [state.items])

  const fetchProducts = useCallback(async (ids: string[]): Promise<Array<ProductInfo & { id: string }>> => {
    if (ids.length === 0) return []
    const response = await fetch('/api/m/space-planner-for-shop/public/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds: ids }),
    })
    if (!response.ok) return []
    const data = (await response.json()) as {
      items: Array<ProductInfo & { id: string }>
      models: Array<{ productId: string; url: string; cacheKey: string; format: string }>
    }
    setProducts((current) => {
      const next = { ...current }
      for (const item of data.items) next[item.id] = { ...item, productId: item.id }
      return next
    })
    setModels((current) => {
      const next = new Map(current)
      for (const model of data.models) next.set(model.productId, model)
      return next
    })
    return data.items
  }, [])

  useEffect(() => {
    const missing = productIds.filter((id) => !products[id])
    if (missing.length === 0) return
    void (async () => {
      try {
        await fetchProducts(missing)
      } catch {
        // The plan still draws: sizes come off the items themselves and the
        // models simply do not appear. Nothing here is worth an error message.
      }
    })()
  }, [productIds, products, fetchProducts])

  // ---- staging from the basket and from a product page ------------------

  useEffect(() => {
    if (!props.stageCart || !started) return
    const staged = cartAsStagedItems()
    if (staged.length === 0) return
    void (async () => {
      const items = await fetchProducts([...new Set(staged.map((entry) => entry.productId))])
      const byId = new Map(items.map((item) => [item.id, item]))
      for (const entry of staged) {
        const info = byId.get(entry.productId)
        if (!info) continue
        dispatch({ type: 'add-item', id: nextId(), product: { ...info, productId: info.id }, x: 0, y: 0, staged: true })
      }
      setMessage({ tone: 'info', text: 'Your basket is in the tray - tap anything in it to drop it into the room.' })
    })()
    // Deliberately once per mount: re-staging on every basket change would
    // duplicate what the shopper has already placed.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [props.stageCart, started])

  useEffect(() => {
    // "See it in your room" from a product page. Unlike the basket, this is one
    // thing the shopper explicitly asked to see, so it goes straight into the
    // room rather than into the tray - having to find it in a tray first would
    // be a strange answer to the button they pressed.
    const wanted = props.stageProductId
    if (!wanted || !started || stagedProductRef.current) return
    stagedProductRef.current = true
    void (async () => {
      const [info] = await fetchProducts([wanted])
      if (!info) return
      const product = { ...info, productId: info.id }
      const spot = findFreeSpot(state.items, state.geometry, product)
      dispatch({ type: 'add-item', id: nextId(), product, x: spot.x, y: spot.y })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the first render after the room exists
  }, [props.stageProductId, started])

  // ---- scratch + unsaved-work guard ------------------------------------

  useEffect(() => {
    if (!started) return
    writeScratch(state.geometry, state.items)
  }, [state.geometry, state.items, started])

  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // ---- derived ----------------------------------------------------------

  const clashes = useMemo(() => findClashes(state.items), [state.items])
  const labels = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [id, info] of Object.entries(products)) out[id] = info.name
    return out
  }, [products])

  const snapshot: ProductSnapshot = useMemo(() => {
    const out: ProductSnapshot = {}
    for (const [id, info] of Object.entries(products)) {
      out[id] = { name: info.name, sku: '', slug: '', price: info.price, taxClassId: null, image: info.image, parentId: null, optionSummary: '' }
    }
    return out
  }, [products])

  const description = useMemo(() => {
    const resolved = new Map<string, ResolvedModel>()
    for (const [productId, model] of models) {
      resolved.set(productId, {
        productId,
        plainUrl: model.cacheKey,
        format: model.format as ResolvedModel['format'],
        yawOffsetDeg: 0,
        noDecimation: false,
      })
    }
    return buildScene(state.geometry, toPlanItems(state), snapshot, resolved)
  }, [state, snapshot, models])

  const prepareOptions = useMemo(
    () => ({
      yawOffsetDeg: 0,
      noDecimation: !props.budgets.decimationEnabled,
      decimationTarget: props.budgets.decimationTarget,
      textureMaxPx: props.budgets.textureMaxPx,
      maxUniqueModels: props.budgets.maxUniqueModels,
    }),
    [props.budgets],
  )

  const placed = useMemo(() => state.items.filter((item) => !item.staged), [state.items])
  const tray = useMemo(() => state.items.filter((item) => item.staged), [state.items])

  // ---- actions ----------------------------------------------------------

  const place = useCallback(
    (card: CatalogueCard) => {
      commit()
      const info: ProductInfo = {
        productId: card.id,
        name: card.name,
        image: card.image,
        priceFormatted: card.priceFormatted,
        price: card.price,
        widthMm: card.widthMm,
        depthMm: card.depthMm,
        heightMm: card.heightMm,
        sizeSource: card.approximateSize ? 'category_default' : 'attribute',
        mount: 'floor',
        underTopHeightMm: null,
        underTopWidthMm: null,
      }
      setProducts((current) => ({ ...current, [card.id]: info }))
      const spot = findFreeSpot(state.items, state.geometry, info)
      dispatch({ type: 'add-item', id: nextId(), product: info, x: spot.x, y: spot.y })
    },
    [commit, nextId, state.geometry, state.items],
  )

  const applyStep = useCallback(
    (step: { history: History; snapshot: { geometry: RoomGeometry; items: PlanItem[] } } | null) => {
      if (!step) return
      setHistory(step.history)
      dispatch({ type: 'load', snapshot: step.snapshot })
      setDirty(true)
    },
    [],
  )

  const savePlan = useCallback(async () => {
    if (!props.signedIn) {
      setMessage({ tone: 'info', text: 'Make an account to keep this - it takes a moment and your room comes with you.' })
      window.location.href = `${props.signInHref}?next=${encodeURIComponent('/space-planner')}`
      return
    }
    setMessage(null)
    try {
      let roomId = savedRoomId
      if (!roomId) {
        const roomResponse = await fetch('/api/m/space-planner-for-shop/member/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My space', notes: '', geometry: state.geometry }),
        })
        const roomData = (await roomResponse.json()) as { room?: { id: string }; error?: string }
        if (!roomResponse.ok || !roomData.room) throw new Error(roomData.error ?? 'Could not save the room')
        roomId = roomData.room.id
        setSavedRoomId(roomId)
      } else {
        await fetch(`/api/m/space-planner-for-shop/member/rooms/${roomId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My space', notes: '', geometry: state.geometry }),
        })
      }

      const body = JSON.stringify({ name: 'Option A', items: toPlanItems(state) })
      const planResponse = savedPlanId
        ? await fetch(`/api/m/space-planner-for-shop/member/plans/${savedPlanId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
        : await fetch(`/api/m/space-planner-for-shop/member/rooms/${roomId}/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })

      const planData = (await planResponse.json()) as { plan?: { id: string }; error?: string }
      if (!planResponse.ok || !planData.plan) throw new Error(planData.error ?? 'Could not save the plan')

      setSavedPlanId(planData.plan.id)
      setDirty(false)
      clearScratch()
      setMessage({ tone: 'info', text: 'Saved. You will find it under "My spaces" in your account.' })
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'We could not save that just now.' })
    }
  }, [props.signedIn, props.signInHref, savedPlanId, savedRoomId, state])

  const sendToCart = useCallback(() => {
    const counts = new Map<string, number>()
    for (const item of placed) counts.set(item.productId, (counts.get(item.productId) ?? 0) + 1)
    const result = addPlanToCart([...counts.entries()].map(([productId, quantity]) => ({ productId, quantity })))
    setMessage(
      result.ok
        ? { tone: 'info', text: `${result.added === 1 ? 'One thing' : `${result.added} things`} added to your basket.` }
        : { tone: 'error', text: result.error },
    )
  }, [placed])

  // ---- keyboard ---------------------------------------------------------

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

      if (event.key === 'Escape') {
        setWallEdit(null)
        setRoomEdit(false)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        applyStep(event.shiftKey ? redo(history, state) : undo(history, state))
        return
      }
      if (state.selection.length === 0) return

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        commit()
        dispatch({ type: 'delete-items', ids: state.selection })
        return
      }
      const nudge = event.shiftKey ? 0 : 10
      const rotate = event.shiftKey ? 15 : 0
      const map: Record<string, [number, number]> = {
        ArrowLeft: [-nudge, 0],
        ArrowRight: [nudge, 0],
        ArrowUp: [0, -nudge],
        ArrowDown: [0, nudge],
      }
      const delta = map[event.key]
      if (!delta) return
      event.preventDefault()
      commit()
      if (rotate) dispatch({ type: 'rotate-items', ids: state.selection, deltaDeg: event.key === 'ArrowLeft' ? -rotate : rotate, snap: true })
      else dispatch({ type: 'move-items', ids: state.selection, dx: delta[0], dy: delta[1], snap: false })
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [state, history, commit, applyStep])

  // ---- render -----------------------------------------------------------

  if (!started) {
    return (
      <div className="spl-root spl-root-intro">
        <style dangerouslySetInnerHTML={{ __html: plannerCss() }} />
        <FirstRun
          heading={props.heading}
          intro={props.intro}
          onReady={(geometry) => {
            dispatch({ type: 'set-geometry', geometry })
            setStarted(true)
          }}
        />
      </div>
    )
  }

  const areaM2 = polygonAreaM2(state.geometry.vertices)

  return (
    <div className="spl-root">
      <style dangerouslySetInnerHTML={{ __html: plannerCss() }} />

      <div className="spl-bar">
        <div className="spl-bar-heading">
          <h1 className="spl-title">{props.heading}</h1>
          <span className="spl-sub">
            {areaM2.toFixed(1)} m² · {placed.length} {placed.length === 1 ? 'item' : 'items'}
            {tray.length > 0 && ` · ${tray.length} waiting`}
          </span>
        </div>
        <div className="spl-bar-spacer" />
        <div className="spl-tabs" role="tablist" aria-label="View">
          {(['plan', 'orbit', 'eye'] as StageView[]).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              className="spl-tab"
              aria-selected={stage === option}
              onClick={() => setStage(option)}
            >
              {VIEW_LABELS[option]}
            </button>
          ))}
        </div>
        <div className="spl-bar-actions">
          <button type="button" className="spl-btn" onClick={() => setRoomEdit(true)}>
            Room
          </button>
          <button type="button" className="spl-btn" onClick={() => applyStep(undo(history, state))} disabled={history.past.length === 0}>
            Undo
          </button>
          <button type="button" className="spl-btn" onClick={() => applyStep(redo(history, state))} disabled={history.future.length === 0}>
            Redo
          </button>
          <button type="button" className="spl-btn" onClick={() => window.print()}>
            Print
          </button>
          <button type="button" className="spl-btn" onClick={sendToCart} disabled={placed.length === 0}>
            Add to basket
          </button>
          <button type="button" className="spl-btn spl-btn-primary" onClick={() => void savePlan()}>
            {props.signedIn ? 'Save' : 'Save (sign in)'}
          </button>
        </div>
      </div>

      {message && (
        <p className={message.tone === 'error' ? 'spl-alert spl-alert-error' : 'spl-alert'} role={message.tone === 'error' ? 'alert' : 'status'}>
          <span className="spl-alert-text">{message.text}</span>
          <button type="button" className="spl-alert-close" onClick={() => setMessage(null)} aria-label="Dismiss">
            ×
          </button>
        </p>
      )}

      <div className="spl-body">
        <div className="spl-stage">
          {stage === 'plan' ? (
            <Plan2d
              geometry={state.geometry}
              items={state.items}
              selection={state.selection}
              labels={labels}
              clashes={clashes}
              walkwayClearanceMm={props.guidance.enabled ? props.guidance.walkwayClearanceMm : 0}
              onSelect={(ids) => {
                dispatch({ type: 'select', ids })
                if (ids.length > 0) setTab('selected')
              }}
              onDragItems={(ids, dx, dy, snap) => dispatch({ type: 'move-items', ids, dx, dy, snap })}
              onDragEnd={commit}
              onWallClick={(wallIndex, currentLengthMm) => setWallEdit({ index: wallIndex, lengthMm: currentLengthMm })}
            />
          ) : (
            <View3d description={description} models={models} options={prepareOptions} view={stage === 'eye' ? 'eye' : 'orbit'} />
          )}

          {wallEdit && (
            <WallDialog
              units={state.geometry.units}
              lengthMm={wallEdit.lengthMm}
              onCancel={() => setWallEdit(null)}
              onSave={(mm) => {
                commit()
                dispatch({ type: 'set-wall-length', wallIndex: wallEdit.index, lengthMm: mm })
                setWallEdit(null)
              }}
            />
          )}

          {roomEdit && (
            <RoomDialog
              geometry={state.geometry}
              itemCount={placed.length}
              onCancel={() => setRoomEdit(false)}
              onCeiling={(mm) => {
                commit()
                dispatch({ type: 'set-geometry', geometry: { ...state.geometry, ceilingMm: mm } })
                setRoomEdit(false)
              }}
              onStartAgain={() => {
                commit()
                setRoomEdit(false)
                setStarted(false)
              }}
            />
          )}
        </div>

        <aside className="spl-side">
          <div className="spl-tabs" role="tablist" aria-label="Panels">
            {(['catalogue', 'selected', 'items'] as Tab[]).map((option) => (
              <button key={option} type="button" role="tab" className="spl-tab" aria-selected={tab === option} onClick={() => setTab(option)}>
                {TAB_LABELS[option]}
                {option === 'selected' && state.selection.length > 0 ? ` (${state.selection.length})` : ''}
              </button>
            ))}
          </div>

          <div className="spl-side-scroll">
            <div className="spl-stack">
              {tray.length > 0 && (
                <div className="spl-stack">
                  <p className="spl-note">Waiting to go in - tap one to drop it into the room.</p>
                  <div className="spl-tray">
                    {tray.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="spl-tray-item"
                        onClick={() => {
                          commit()
                          const spot = findFreeSpot(state.items, state.geometry, item)
                          dispatch({ type: 'unstage-item', id: item.id, x: spot.x, y: spot.y })
                        }}
                      >
                        {labels[item.productId] ?? 'Item'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {tab === 'catalogue' && <CataloguePanel onPlace={place} />}

              {tab === 'selected' && (
                <SelectedPanel
                  state={state}
                  products={products}
                  onPatch={(id, patch) => { commit(); dispatch({ type: 'set-item', id, patch }) }}
                  onDelete={(ids) => { commit(); dispatch({ type: 'delete-items', ids }) }}
                  onDuplicate={(ids) => { commit(); dispatch({ type: 'duplicate-items', ids, offsetMm: 200, newIds: ids.map(() => nextId()) }) }}
                  onArray={(id, count, spacing) => {
                    commit()
                    dispatch({ type: 'array-item', id, count, spacingMm: spacing, alongYaw: 0, newIds: Array.from({ length: count }, () => nextId()) })
                  }}
                />
              )}

              {tab === 'items' && <ItemListPanel items={placed} products={products} disclaimer={props.guidance.disclaimer} currencySymbol={props.currencySymbol} />}
            </div>
          </div>
        </aside>
      </div>

      {/* The printed sheet. On screen this is display:none; on paper it is the
          document somebody hands over, so it carries the item list and the
          wording that says what the plan is and is not. */}
      <div className="spl-print-only">
        <div className="spl-print-head">
          <h2>{props.heading}</h2>
          <span>
            {areaM2.toFixed(1)} m² · {placed.length} {placed.length === 1 ? 'item' : 'items'}
          </span>
        </div>
        <ItemListPanel items={placed} products={products} disclaimer={props.guidance.disclaimer} currencySymbol={props.currencySymbol} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/**
 * Typing a wall's length.
 *
 * A dialog rather than window.prompt. prompt is styled by the browser, blocked
 * outright by some of them, and to a shopper it looks like the page has been
 * taken over by something else - which is not the impression you want at the
 * moment somebody is telling you the size of their office.
 */
function WallDialog(props: { units: RoomGeometry['units']; lengthMm: number; onCancel: () => void; onSave: (mm: number) => void }) {
  const fieldId = useId()
  const [value, setValue] = useState(() => formatLength(props.lengthMm, props.units))
  const [error, setError] = useState('')

  const submit = () => {
    const mm = parseLengthMm(value, props.units === 'imperial' ? 'in' : 'mm')
    if (!mm || mm < 100) {
      setError('That did not read as a length. Try something like 3.2m or 3200.')
      return
    }
    props.onSave(Math.round(mm))
  }

  return (
    <div className="spl-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) props.onCancel() }}>
      <form
        className="spl-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Wall length"
        onSubmit={(event) => { event.preventDefault(); submit() }}
      >
        <h2>How long is this wall?</h2>
        <div className="spl-field">
          <label htmlFor={fieldId}>Inside measurement</label>
          <input id={fieldId} className="spl-input" value={value} autoFocus onChange={(event) => { setValue(event.target.value); setError('') }} />
        </div>
        <p className="spl-note">4200, 4.2m and 13&apos; 9&quot; all work.</p>
        {error && <p className="spl-alert spl-alert-error"><span className="spl-alert-text">{error}</span></p>}
        <div className="spl-buttons">
          <button type="button" className="spl-btn" onClick={props.onCancel}>Cancel</button>
          <button type="submit" className="spl-btn spl-btn-primary">Set the length</button>
        </div>
      </form>
    </div>
  )
}

/** The room itself, after the first run: ceiling height, and the way back out. */
function RoomDialog(props: {
  geometry: RoomGeometry
  itemCount: number
  onCancel: () => void
  onCeiling: (mm: number) => void
  onStartAgain: () => void
}) {
  const fieldId = useId()
  const [value, setValue] = useState(() => formatLength(props.geometry.ceilingMm, props.geometry.units))
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="spl-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) props.onCancel() }}>
      <form
        className="spl-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Room"
        onSubmit={(event) => {
          event.preventDefault()
          const mm = parseLengthMm(value, props.geometry.units === 'imperial' ? 'in' : 'mm')
          if (!mm || mm < 1500 || mm > 20_000) {
            setError('Ceilings between 1.5 m and 20 m, please.')
            return
          }
          props.onCeiling(Math.round(mm))
        }}
      >
        <h2>Your room</h2>
        <p className="spl-note">To change a wall, click it on the flat plan and type its length.</p>
        <div className="spl-field">
          <label htmlFor={fieldId}>Ceiling height</label>
          <input id={fieldId} className="spl-input" value={value} autoFocus onChange={(event) => { setValue(event.target.value); setError('') }} />
        </div>
        {error && <p className="spl-alert spl-alert-error"><span className="spl-alert-text">{error}</span></p>}
        <div className="spl-buttons">
          <button type="button" className="spl-btn" onClick={props.onCancel}>Close</button>
          <button type="submit" className="spl-btn spl-btn-primary">Save the height</button>
        </div>
        <hr style={{ border: 0, borderTop: '1px solid var(--color-border)', margin: 0 }} />
        {confirming ? (
          <>
            <p className="spl-note">
              Starting again keeps {props.itemCount === 1 ? 'the one thing' : `all ${props.itemCount} things`} you have chosen but throws the room away.
            </p>
            <div className="spl-buttons">
              <button type="button" className="spl-btn" onClick={() => setConfirming(false)}>Keep this room</button>
              <button type="button" className="spl-btn spl-btn-danger" onClick={props.onStartAgain}>Start again</button>
            </div>
          </>
        ) : (
          <button type="button" className="spl-btn" onClick={() => setConfirming(true)}>Start the room again</button>
        )}
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

/**
 * The first fifteen seconds.
 *
 * This is the most complex thing on the site by a distance, and everything else
 * in the module is downstream of somebody getting past this screen. So it is a
 * three-way choice and nothing else: a preset, a typed size, or a shape to
 * adjust. No modal tour, no video.
 *
 * The typed route is not a convenience - it is the only workable path for a
 * keyboard or screen-reader user, and it is how somebody standing in the room
 * with a tape measure actually holds the information.
 */
function FirstRun(props: { heading: string; intro: string; onReady: (geometry: RoomGeometry) => void }) {
  const ids = useId()
  const [mode, setMode] = useState<'choose' | 'type'>('choose')
  const [width, setWidth] = useState('6.2m')
  const [depth, setDepth] = useState('4.1m')
  const [ceiling, setCeiling] = useState('2.4m')
  const [error, setError] = useState('')

  const preset = (widthMm: number, depthMm: number) => {
    props.onReady({
      ...defaultRoomGeometry(),
      vertices: [
        { x: 0, y: 0 },
        { x: widthMm, y: 0 },
        { x: widthMm, y: depthMm },
        { x: 0, y: depthMm },
      ],
    })
  }

  if (mode === 'type') {
    return (
      <div className="spl-first-run">
        <h1 className="spl-title">Your room</h1>
        <p className="spl-note">Inside measurements, in whatever units you like - 4200, 4.2m and 13&apos; 9&quot; all work.</p>
        <div className="spl-row">
          <div className="spl-field">
            <label htmlFor={`${ids}-w`}>Width</label>
            <input id={`${ids}-w`} className="spl-input" value={width} onChange={(event) => setWidth(event.target.value)} />
          </div>
          <div className="spl-field">
            <label htmlFor={`${ids}-d`}>Depth</label>
            <input id={`${ids}-d`} className="spl-input" value={depth} onChange={(event) => setDepth(event.target.value)} />
          </div>
          <div className="spl-field">
            <label htmlFor={`${ids}-c`}>Ceiling</label>
            <input id={`${ids}-c`} className="spl-input" value={ceiling} onChange={(event) => setCeiling(event.target.value)} />
          </div>
        </div>
        {error && <p className="spl-alert spl-alert-error"><span className="spl-alert-text">{error}</span></p>}
        <div className="spl-buttons">
          <button type="button" className="spl-btn" onClick={() => setMode('choose')}>Back</button>
          <button
            type="button"
            className="spl-btn spl-btn-primary"
            onClick={() => {
              const w = parseLengthMm(width)
              const d = parseLengthMm(depth)
              const c = parseLengthMm(ceiling)
              if (!w || !d || !c || w < 500 || d < 500) {
                setError('One of those did not read as a length. Try something like 4.2m or 4200.')
                return
              }
              props.onReady({
                ...defaultRoomGeometry(),
                ceilingMm: Math.min(20_000, Math.max(1500, c)),
                vertices: [
                  { x: 0, y: 0 },
                  { x: w, y: 0 },
                  { x: w, y: d },
                  { x: 0, y: d },
                ],
              })
            }}
          >
            That is my room
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="spl-first-run">
      <h1 className="spl-title">{props.heading}</h1>
      <p className="spl-note">{props.intro}</p>
      <div className="spl-choices">
        <button type="button" className="spl-choice" onClick={() => setMode('type')}>
          <strong>I know the measurements</strong>
          <span className="spl-note">Type the width and depth. Quickest by a mile.</span>
        </button>
        <button type="button" className="spl-choice" onClick={() => preset(4000, 3000)}>
          <strong>Small office</strong>
          <span className="spl-note">4 × 3 m to start with. Change any wall afterwards.</span>
        </button>
        <button type="button" className="spl-choice" onClick={() => preset(8000, 6000)}>
          <strong>Open plan</strong>
          <span className="spl-note">8 × 6 m. Room for a bank of desks.</span>
        </button>
      </div>
      <p className="spl-note">
        Whichever you pick, you can click any wall afterwards and type its real length - the rest of the room follows.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Side panels
// ---------------------------------------------------------------------------

/**
 * The properties panel.
 *
 * It serves the precision user, and it is the accessible editing path for
 * everything the canvas does by dragging. That second job is why it carries the
 * exact position and rotation as numbers rather than as sliders.
 */
function SelectedPanel(props: {
  state: PlannerState
  products: Record<string, ProductInfo>
  onPatch: (id: string, patch: Partial<PlanItem>) => void
  onDelete: (ids: string[]) => void
  onDuplicate: (ids: string[]) => void
  onArray: (id: string, count: number, spacingMm: number) => void
}) {
  const selected = props.state.items.filter((item) => props.state.selection.includes(item.id))
  const first = selected[0]

  if (!first) return <p className="spl-note">Nothing selected. Click something in the room, or add something from Add things.</p>

  return (
    <div className="spl-stack">
      <strong>{props.products[first.productId]?.name ?? 'Item'}</strong>
      {selected.length > 1 && <span className="spl-note">{selected.length} selected - changes apply to the first.</span>}

      <div className="spl-row">
        <NumberField label="Across (mm)" value={first.x} onChange={(value) => props.onPatch(first.id, { x: value })} />
        <NumberField label="Down (mm)" value={first.y} onChange={(value) => props.onPatch(first.id, { y: value })} />
        <NumberField label="Turn (°)" value={Math.round(first.yaw)} onChange={(value) => props.onPatch(first.id, { yaw: value })} />
      </div>

      <div className="spl-row">
        <NumberField label="Width" value={first.widthMm} onChange={(value) => props.onPatch(first.id, { widthMm: value, manualSize: true })} />
        <NumberField label="Depth" value={first.depthMm} onChange={(value) => props.onPatch(first.id, { depthMm: value, manualSize: true })} />
        <NumberField label="Height" value={first.heightMm} onChange={(value) => props.onPatch(first.id, { heightMm: value, manualSize: true })} />
      </div>

      {(first.sizeSource === 'category_default' || first.sizeSource === 'marker') && (
        <p className="spl-note">
          We do not have exact measurements for this one, so the size shown is typical for its category. Type the real one if you have it.
        </p>
      )}

      <div className="spl-buttons">
        <button type="button" className="spl-btn" onClick={() => props.onPatch(first.id, { yaw: Math.round(first.yaw) + 90 })}>Turn 90°</button>
        <button type="button" className="spl-btn" onClick={() => props.onDuplicate(props.state.selection)}>Duplicate</button>
        <button type="button" className="spl-btn" onClick={() => props.onArray(first.id, 3, first.widthMm + 100)}>Row of four</button>
        <button type="button" className="spl-btn spl-btn-danger" onClick={() => props.onDelete(props.state.selection)}>Remove</button>
      </div>
    </div>
  )
}

function NumberField(props: { label: string; value: number; onChange: (value: number) => void }) {
  const id = useId()
  return (
    <div className="spl-field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        className="spl-input"
        type="number"
        value={Math.round(props.value)}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) props.onChange(value)
        }}
      />
    </div>
  )
}

/**
 * The item list, which doubles as the accessible representation of the scene:
 * everything in the room, enumerated, with its size. A screen reader gets the
 * whole plan from this table, and so does the printer.
 */
function ItemListPanel(props: { items: PlanItem[]; products: Record<string, ProductInfo>; disclaimer: string; currencySymbol: string }) {
  const counts = new Map<string, number>()
  for (const item of props.items) counts.set(item.productId, (counts.get(item.productId) ?? 0) + 1)

  if (counts.size === 0) return <p className="spl-note">Nothing in the room yet.</p>

  const rows = [...counts.entries()]
  const total = rows.reduce((sum, [productId, quantity]) => sum + (props.products[productId]?.price ?? 0) * quantity, 0)
  const anyPriced = rows.some(([productId]) => (props.products[productId]?.price ?? 0) > 0)

  return (
    <div className="spl-stack">
      <table className="spl-bom">
        <caption className="spl-note" style={{ textAlign: 'left', paddingBottom: '0.3rem' }}>
          Everything in the room
        </caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="spl-num">Qty</th>
            <th scope="col" className="spl-num">Each</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([productId, quantity]) => (
            <tr key={productId}>
              <td>{props.products[productId]?.name ?? 'Item'}</td>
              <td className="spl-num">{quantity}</td>
              <td className="spl-num">{props.products[productId]?.priceFormatted ?? '-'}</td>
            </tr>
          ))}
        </tbody>
        {anyPriced && (
          <tfoot>
            <tr>
              <td>Roughly</td>
              <td className="spl-num">{props.items.length}</td>
              <td className="spl-num">{formatMoney(total, props.currencySymbol)}</td>
            </tr>
          </tfoot>
        )}
      </table>
      <p className="spl-note">{props.disclaimer}</p>
    </div>
  )
}
