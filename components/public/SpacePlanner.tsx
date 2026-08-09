'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'
import { formatMoney } from '@/modules/shop/lib/money'
import { CataloguePanel } from '@/modules/space-planner-for-shop/components/public/CataloguePanel'
import { Plan2d } from '@/modules/space-planner-for-shop/components/public/Plan2d'
import type { PlanMode } from '@/modules/space-planner-for-shop/components/public/Plan2d'
import { plannerCss } from '@/modules/space-planner-for-shop/components/public/planner-css'
import { addPlanToCart, cartAsStagedItems, readCart } from '@/modules/space-planner-for-shop/lib/client/cart-bridge'
import { clearScratch, readScratch, writeScratch } from '@/modules/space-planner-for-shop/lib/client/scratch'
import {
  CLASH_WITH_OBSTRUCTION,
  emptyState,
  findClashes,
  findFreeSpot,
  plannerReducer,
  pushHistory,
  redo,
  toPlanItems,
  undo,
} from '@/modules/space-planner-for-shop/lib/client/planner-store'
import type { History, PlannerState, ProductInfo, SpotItem } from '@/modules/space-planner-for-shop/lib/client/planner-store'
import { countPlanProducts, planProductIds } from '@/modules/space-planner-for-shop/lib/plan-counts'
import { buildScene } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { ResolvedModel } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { FabricSlot } from '@/modules/space-planner-for-shop/lib/three/planner-model'
import { boundingBox, normaliseYaw, polygonAreaM2, validateRoomGeometry } from '@/modules/space-planner-for-shop/lib/geometry'
import { formatLength, parseLengthMm } from '@/modules/space-planner-for-shop/lib/units'
import { PLAN_SCHEMA_VERSION, defaultRoomGeometry } from '@/modules/space-planner-for-shop/lib/types'
import { MAX_ITEMS } from '@/modules/space-planner-for-shop/lib/validation'
import type {
  OpeningKind,
  PlanItem,
  ProductSnapshot,
  RoomGeometry,
  SavedCamera,
  SplRoomView,
  Vertex,
} from '@/modules/space-planner-for-shop/lib/types'
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** What a refused save answers with. `needsSignIn` comes from the member gate. */
type SaveFailure = { error?: string; needsSignIn?: boolean }

/** The session went while the tab was open. Handled, never shown. */
class NeedsSignIn extends Error {}

/**
 * The saved copy has gone - deleted from another tab, or from another device.
 *
 * Its own type because the ONLY useful response is to forget the id and let the
 * next Save make a fresh one. Said as a plain message, the advice was a lie: the
 * planner went on PUTting to the same dead id for ever, so "press Save again"
 * produced the identical failure every time, and the room version told the
 * shopper to press Start again - which throws the room outline away. Following
 * the instruction destroyed the work it was supposed to rescue.
 */
class SavedCopyGone extends Error {
  constructor(readonly what: 'space' | 'layout') {
    super(
      what === 'space'
        ? 'That space is no longer there - it may have been deleted somewhere else. Press Save again and it will be kept as a new one.'
        : 'That layout is no longer there - it may have been deleted somewhere else. Press Save again and it will be kept as a new one.',
    )
  }
}

/**
 * A refused save, worded for the person who pressed the button.
 *
 * The routes answer in their own terms - "Not found", "Forbidden", a validation
 * message - and those went straight into the planner's alert bar. Deleting a
 * room in another tab and then pressing Save read, in full, "Not found".
 *
 * So: the two cases worth naming are named, and everything else gets one plain
 * sentence rather than whatever the server happened to say.
 */
async function saveError(response: Response, data: SaveFailure | null, what: 'space' | 'layout'): Promise<Error> {
  if (response.status === 401 || data?.needsSignIn) return new NeedsSignIn()
  if (response.status === 404) return new SavedCopyGone(what)
  // A refusal the shopper can act on: too many rooms, a room that folds through
  // itself. Those the routes word for a shopper already, so they are passed on.
  // 413 belongs here too. The routes write a proper sentence for it - "that
  // room is bigger than we can store, simplify the outline" - and replacing it
  // with "try again in a moment" sent the shopper round a loop that could only
  // ever fail the same way.
  if (response.status === 400 || response.status === 409 || response.status === 413) {
    return new Error(data?.error ?? `We could not save that ${what} just now.`)
  }
  return new Error(`We could not save that ${what} just now. Please try again in a moment.`)
}

/**
 * Wait for a view to be able to photograph itself, then photograph it.
 *
 * Polled rather than awaited on a promise, because what is being waited for is a
 * component mounting, registering itself and finishing a build - three things
 * spread across React's own scheduling with no single moment to hang a callback
 * on. It gives up rather than hanging: a document missing one picture is a
 * document; an export that never returns is a bug report.
 */
async function waitForCapture(
  ref: { current: (() => string | null) | null },
  ready: () => boolean = () => true,
  timeoutMs = 15_000,
): Promise<string | null> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (ready() && ref.current) {
      const image = ref.current()
      if (image) return image
    }
    await delay(120)
  }
  return null
}

/**
 * Keyboard containment for the planner's dialogs.
 *
 * Three jobs, none optional for a modal that claims aria-modal: something
 * inside gets focus when it opens (unless React's own autoFocus already gave it
 * out), Tab cycles within it rather than wandering off into the page behind,
 * and whatever had focus before it opened gets it back when it closes. Escape
 * closes the dialog itself and stops there, so the global Escape handler does
 * not also clear selections behind it.
 */
function useDialogFocus<T extends HTMLElement>(onClose?: () => void) {
  const ref = useRef<T | null>(null)
  const closeRef = useRef(onClose)
  // In an effect rather than during render - the rule is real, and the handler
  // below only reads this after the commit anyway.
  useEffect(() => {
    closeRef.current = onClose
  })

  // Captured during the FIRST RENDER, not in the effect below.
  //
  // React applies `autoFocus` while it commits, which is before a passive
  // effect runs - this hook relies on that two lines further down. So by the
  // time the effect read document.activeElement, focus was already inside the
  // dialog and "the opener" was one of the dialog's own controls: on close it
  // called focus() on a node that had just been removed from the document, and
  // the keyboard user landed on <body> and tabbed from the top of the site. A
  // lazy state initialiser runs before the commit, so it sees the real opener.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' || !(document.activeElement instanceof HTMLElement) ? null : document.activeElement,
  )

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const selector = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    if (!node.contains(document.activeElement)) {
      node.querySelector<HTMLElement>(selector)?.focus()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeRef.current) {
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusables = [...node.querySelectorAll<HTMLElement>(selector)]
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
    }
    node.addEventListener('keydown', onKey)
    return () => {
      node.removeEventListener('keydown', onKey)
      // Only if it is still on the page: the control that opened a dialog can
      // perfectly well have been what the dialog removed.
      if (opener && opener.isConnected) opener.focus()
    }
  }, [opener])

  return ref
}

/** One resolved model as the browser holds it - see lib/model-resolver's ClientModel. */
type PlannerModel = {
  /**
   * The product this file belongs to.
   *
   * Kept because the map it lives in is keyed `productId@@context` for a
   * combined variant, so the key is not the product id and cannot stand in for
   * one.
   */
  productId: string
  url: string
  cacheKey: string
  format: string
  yawOffsetDeg: number
  noDecimation: boolean
  /** '' where the product has no fabric configured. See lib/three/planner-model. */
  fabricKey: string
  slots: FabricSlot[]
  /** The size the shop recorded for this variation in 3D views. See model-scale. */
  realMetres: number | null
  realAxis: 'height' | 'width'
}

/**
 * A saved room and layout, loaded on the server and handed straight in.
 *
 * Passed as a prop rather than fetched on mount so that opening something from
 * "My spaces" comes up with the room already drawn, instead of showing the
 * first-run screen for a beat to somebody who has plainly been past it.
 */
export type OpenPlan = {
  /** Null when a room is opened for a NEW layout in it. */
  planId: string | null
  roomId: string
  roomName: string
  planName: string
  geometry: RoomGeometry
  items: PlanItem[]
}

/**
 * One room the member has already saved, as the opening screen offers it.
 *
 * Flattened to the one link that matters rather than handed the whole room:
 * somebody picking a room off a list means "put me back where I was", so a room
 * with layouts in it points at its most recent one. The full tree of rooms and
 * their layouts is My spaces' job, and this list links there rather than growing
 * into a second copy of it.
 */
export type SavedRoomLink = {
  id: string
  name: string
  areaM2: number
  planCount: number
  /** The layout to open. Null when nothing has been laid out in the room yet. */
  planId: string | null
}

export type SpacePlannerProps = {
  signedIn: boolean
  signInHref: string
  heading: string
  intro: string
  budgets: { maxUniqueModels: number; decimationTarget: number; textureMaxPx: number; decimationEnabled: boolean }
  /**
   * How many things this shop allows in one layout - the owner's own setting,
   * and the number the server refuses on.
   *
   * Passed in rather than assumed, because the browser was quoting the SCHEMA's
   * hard ceiling of 400 while the server refused at this, which defaults to 200:
   * a shopper with a 250-line basket was told 400 was fine, watched all 250
   * stage, placed them, and was then refused with "we top out at 200". The two
   * also count differently - the schema counts the tray as well, the setting
   * counts only what is in the room - so quoting either one at the wrong moment
   * is a promise the other will break.
   */
  maxItemsPerPlan: number
  guidance: { walkwayClearanceMm: number; disclaimer: string; enabled: boolean }
  /**
   * What the shop says about the prices on the item list.
   *
   * A different sentence from the spacing guidance, and it was missing: the item
   * list printed the spacing disclaimer under a column of money, so the only
   * caveat a shopper read beside a total was about how far apart to put desks.
   * The PDF and the shared page have carried this wording all along.
   */
  priceDisclaimer: string
  /** Whatever this shop prints in front of a number. Never assumed to be a pound. */
  currencySymbol: string
  /**
   * Whether a photoreal picture can actually be asked for.
   *
   * Switched on AND wired up, worked out on the server, because those are two
   * different things and a button that answers "the picture service is not set
   * up on this site yet" is worse than no button at all.
   */
  rendersAvailable: boolean
  /** A room and layout the member already saved, opened from My spaces. */
  openPlan?: OpenPlan | null
  /**
   * Rooms this member has saved before, for the opening screen to offer.
   *
   * Empty for a signed-out visitor, and empty for a member who has never saved
   * anything - in both cases the screen simply does not mention it, rather than
   * showing an empty list with an explanation attached.
   */
  savedRooms?: SavedRoomLink[]
  /** Staged straight from the basket when the shopper arrived from the cart. */
  stageCart: boolean
  /** Pre-staged single product when they arrived from a product page. */
  stageProductId?: string | null
}

type Tab = 'catalogue' | 'tray' | 'selected' | 'items'
/**
 * The two surfaces, named for what you do on them rather than for how they are
 * drawn. "Stand in it" went with them: a camera parked at head height inside a
 * part-furnished room is a novelty the first time and an obstacle every time
 * after, and the orbit view answers the same question better.
 */
type StageView = 'plan' | 'orbit'

const VIEW_LABELS: Record<StageView, string> = { plan: 'Edit', orbit: 'Preview' }
const TAB_LABELS: Record<Tab, string> = { catalogue: 'Add things', tray: 'Cart', selected: 'Selected', items: 'Item list' }

export function SpacePlanner(props: SpacePlannerProps) {
  const [state, dispatch] = useReducer(plannerReducer, undefined, () => emptyState(defaultRoomGeometry()))
  const [history, setHistory] = useState<History>({ past: [], future: [] })
  const [started, setStarted] = useState(false)
  const [tab, setTab] = useState<Tab>('catalogue')
  const [stage, setStage] = useState<StageView>('plan')
  const [products, setProducts] = useState<Record<string, ProductInfo>>({})
  const [models, setModels] = useState<Map<string, PlannerModel>>(new Map())
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  /** What the Cart tab says about basket lines that could not come along. */
  const [trayNote, setTrayNote] = useState('')
  const [savedPlanId, setSavedPlanId] = useState<string | null>(props.openPlan?.planId ?? null)
  const [savedRoomId, setSavedRoomId] = useState<string | null>(props.openPlan?.roomId ?? null)
  /**
   * The same room id, readable the instant savePlan returns.
   *
   * A caller that saves on its way to doing something else - saving a viewpoint,
   * asking for a picture - needs the room id in the very next statement, and
   * setSavedRoomId has not landed by then. Two copies of one value is a smell,
   * so this one is written in exactly one place and never read anywhere the
   * state would do.
   */
  const roomIdRef = useRef<string | null>(props.openPlan?.roomId ?? null)
  /** Whether a save is in flight - see savePlan for what two at once did. */
  const savingRef = useRef(false)
  // The names travel with the plan. Saving over somebody's "Ground floor, east
  // wing" and calling it "My space" would be a small theft.
  const [roomName, setRoomName] = useState(props.openPlan?.roomName ?? 'My space')
  const [planName] = useState(props.openPlan?.planName ?? 'Option A')
  /** Whether the room's name is being typed rather than read. */
  const [namingRoom, setNamingRoom] = useState(false)
  /**
   * Whether the rename field was escaped rather than finished.
   *
   * Escape blurs the field, and blur is what commits - so without this, backing
   * out of a rename would save the half-typed name that was being backed out of.
   */
  const nameAbandoned = useRef(false)
  const [dirty, setDirty] = useState(false)
  const [wallEdit, setWallEdit] = useState<{ index: number; lengthMm: number } | null>(null)
  const [roomEdit, setRoomEdit] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  /** Whether the start-again confirmation is up. */
  const [startAgain, setStartAgain] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  /**
   * Which part of the export is happening, in the shopper's words.
   *
   * The dialog said "Making it…" from the first press to the last byte - a span
   * that with three saved views ticked can be a minute and a half, most of it
   * photographing things one at a time, with Cancel disabled, Escape refused,
   * the backdrop refused and one unchanging word to go on.
   */
  const [exportStep, setExportStep] = useState('')
  const [photos, setPhotos] = useState(false)
  /**
   * Viewpoints saved against this ROOM, not this layout.
   *
   * Room-scoped because a camera pose is expressed in room coordinates: it means
   * nothing anywhere else, and exactly the same thing for every layout inside the
   * one room. So "from the doorway" photographs Option A and Option B from the
   * identical spot, which is the comparison somebody laying out an office is
   * actually trying to make.
   */
  const [views, setViews] = useState<SplRoomView[]>([])
  const [viewsBusy, setViewsBusy] = useState(false)
  /** A viewpoint to put the camera back on. The nonce re-arms it - see View3d. */
  const [restore, setRestore] = useState<{ camera: SavedCamera; nonce: number } | null>(null)
  /** Reads where the 3D camera is standing. Handed up by View3d, null before it mounts. */
  const cameraProbe = useRef<(() => SavedCamera | null) | null>(null)
  /** Where they were standing when they pressed "Make a photo". See that button. */
  const [photoCamera, setPhotoCamera] = useState<SavedCamera | null>(null)
  /**
   * What the flat plan's pointer means. Editing the room is a mode rather than a
   * second screen, so the shopper never loses sight of what they have already
   * put in it - and a room of any number of walls is reachable without leaving
   * the surface they are already looking at.
   */
  const [planMode, setPlanMode] = useState<PlanMode>('furnish')
  /** Which door or window is being edited, and what the next tap on a wall makes. */
  const [openingSelectionId, setOpeningSelection] = useState<string | null>(null)
  const [openingKind, setOpeningKind] = useState<OpeningKind>('door')
  /** Which column or other obstruction is being edited on the plan. */
  const [obstructionSelectionId, setObstructionSelection] = useState<string | null>(null)
  // A selected column or door that no longer exists is not a selection.
  //
  // Both of these are React state of their own, so `load` - the undo and redo
  // path - restored the geometry and left them naming something gone. The
  // furnish toolbar is replaced by the columns toolbar whenever a column is
  // selected, so undoing a column left that toolbar on screen, finding nothing,
  // saying "tap the floor where the column stands" - and taking Undo, Redo,
  // Save, Add to basket, More, Room and Start again away with it. On a phone
  // that is the whole of the chrome, and the way out is a Done button belonging
  // to a mode nobody asked to be in.
  //
  // Derived rather than cleared in the undo handler, because undo is not the
  // only way to lose one - reshaping a room, loading a plan and the
  // displacement pass all can - and because deriving it cannot flash the wrong
  // toolbar for a frame on the way to fixing itself.
  const obstructionSelection =
    obstructionSelectionId && state.geometry.obstructions.some((entry) => entry.id === obstructionSelectionId)
      ? obstructionSelectionId
      : null
  const openingSelection =
    openingSelectionId && state.geometry.openings.some((entry) => entry.id === openingSelectionId)
      ? openingSelectionId
      : null
  /**
   * Whether the 3D view uses a perspective camera.
   *
   * Off gives a flat, architectural projection - parallel lines stay parallel,
   * so two desks the same size measure the same on screen wherever they are in
   * the room. On is how the room will look to somebody standing in it. Both are
   * right for different questions, which is why it is a switch and not a
   * decision made for everybody.
   */
  const [perspective, setPerspective] = useState(true)
  const shapeBeforeDraw = useRef<RoomGeometry | null>(null)
  /** The outline as it was before the shape gesture in progress - see applyShape. */
  const shapeBeforeEdit = useRef<RoomGeometry | null>(null)
  const idCounter = useRef(0)
  const stagedProductRef = useRef(false)
  /** Whether the basket has already been read in. See the effect that sets it. */
  const stagedCartRef = useRef(false)
  /**
   * How many things are in the room right now.
   *
   * A ref rather than a dependency, because staging from the basket must not
   * rebuild itself on every furniture edit - the same reason its callback
   * deliberately leaves `state.items` out. See the cap in stageFromCart.
   *
   * Kept up to date here, above the effect that stages the basket, so that on a
   * saved plan opened with a basket waiting the count is already right when the
   * cap is worked out. Effects run in the order they are declared.
   */
  const placedCountRef = useRef(0)
  useEffect(() => {
    placedCountRef.current = state.items.filter((item) => !item.staged).length
  }, [state.items])
  /**
   * Product ids already asked about, whatever came back.
   *
   * Without it, a product that no longer answers - deleted from the catalogue,
   * hidden, or simply gone - is asked for again on every render for ever: the
   * effect below keys on `products`, and every reply replaces that object even
   * when it carries nothing. A saved plan holding one retired desk quietly
   * turned into an unbounded stream of requests.
   */
  const askedFor = useRef(new Set<string>())
  /** Ways to photograph the two views, handed up by the views themselves. */
  const capturePlan = useRef<(() => string | null) | null>(null)
  const captureView = useRef<(() => string | null) | null>(null)
  /**
   * Whether the 3D view is still assembling itself.
   *
   * In a ref rather than in state because the only reader is the export, which
   * polls from inside an async callback - and a callback reading state reads
   * whatever it was when the callback was made, which for a thing being waited
   * on is always "still busy".
   */
  const viewBusy = useRef(true)

  const nextId = useCallback(() => {
    idCounter.current += 1
    return `i${Date.now().toString(36)}${idCounter.current}`
  }, [])

  const commit = useCallback(() => {
    setHistory((current) => pushHistory(current, state))
    setDirty(true)
  }, [state])

  // ---- first run --------------------------------------------------------

  const opened = props.openPlan
  useEffect(() => {
    // A saved plan wins over the browser's scratch copy: it is the thing the
    // shopper just clicked on.
    if (opened) {
      queueMicrotask(() => {
        dispatch({ type: 'load', snapshot: { geometry: opened.geometry, items: opened.items } })
        setStarted(true)
      })
      return
    }
    // Otherwise, restoring what a signed-out visitor was in the middle of. It
    // has to be an effect rather than a lazy initial state: localStorage does
    // not exist while this renders on the server, and reading it during the
    // first client render would hand back different markup than the server sent.
    // Deferred by a microtask so the restore lands as its own update rather than
    // cascading out of the first paint.
    const scratch = readScratch()
    if (!scratch) return
    queueMicrotask(() => {
      dispatch({ type: 'load', snapshot: { geometry: scratch.geometry, items: scratch.items } })
      if (scratch.roomName) setRoomName(scratch.roomName)
      setStarted(true)
    })
  }, [opened])

  // ---- product data -----------------------------------------------------

  // Companions included. They are priced into the item list and the running
  // total like anything else, so they need their name and their price - without
  // this they counted towards the total as nothing at all.
  const productIds = useMemo(() => planProductIds(state.items), [state.items])

  const fetchProducts = useCallback(async (
    ids: string[],
    // Add-on combinations to resolve beside the base models - see the products
    // route. The models map keys a variant as `${productId}@@${context}`, the
    // same composite the scene's lookup builds; base entries keep the bare id.
    contexts?: Array<{ productId: string; context: string; extraValueIds: string[] }>,
  ): Promise<Array<ProductInfo & { id: string }>> => {
    if (ids.length === 0) return []
    const response = await fetch('/api/m/space-planner-for-shop/public/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds: ids, ...(contexts?.length ? { contexts } : {}) }),
    })
    // Thrown rather than answered empty. An empty answer is indistinguishable
    // from "none of those products exist any more", which is how a shop having
    // a bad five minutes told a customer that everything in their basket had
    // been discontinued. Callers that genuinely do not mind catch it.
    if (!response.ok) throw new Error('The shop did not answer.')
    const data = (await response.json()) as {
      items: Array<ProductInfo & { id: string }>
      models: Array<PlannerModel & { productId: string; context?: string }>
    }
    setProducts((current) => {
      const next = { ...current }
      for (const item of data.items) next[item.id] = { ...item, productId: item.id }
      return next
    })
    setModels((current) => {
      const next = new Map(current)
      for (const model of data.models) {
        next.set(model.context ? `${model.productId}@@${model.context}` : model.productId, model)
      }
      return next
    })
    return data.items
  }, [])

  useEffect(() => {
    const missing = productIds.filter((id) => !products[id] && !askedFor.current.has(id))
    if (missing.length === 0) return
    for (const id of missing) askedFor.current.add(id)
    void (async () => {
      try {
        await fetchProducts(missing)
      } catch {
        // The plan still draws: sizes come off the items themselves and the
        // models simply do not appear. Nothing here is worth an error message -
        // but a request that failed on the network deserves another go the next
        // time the plan changes, so those ids come back out of the set.
        for (const id of missing) askedFor.current.delete(id)
      }
    })()
  }, [productIds, products, fetchProducts])

  // A reopened plan carries items with an add-on combination (a desk saved with
  // its screens) whose combined models the effect above never asks for - it
  // fetches by product id alone. Ask for any composite the models map lacks,
  // through the same guard set so a failed request retries and a resolved one
  // is never asked twice.
  useEffect(() => {
    const wanted = new Map<string, { productId: string; context: string; extraValueIds: string[] }>()
    for (const item of state.items) {
      if (!item.modelContext?.context) continue
      const key = `${item.productId}@@${item.modelContext.context}`
      if (models.has(key) || askedFor.current.has(key) || wanted.has(key)) continue
      wanted.set(key, { productId: item.productId, context: item.modelContext.context, extraValueIds: item.modelContext.extraValueIds })
    }
    if (wanted.size === 0) return
    for (const key of wanted.keys()) askedFor.current.add(key)
    void (async () => {
      try {
        await fetchProducts([...new Set([...wanted.values()].map((w) => w.productId))], [...wanted.values()])
      } catch {
        for (const key of wanted.keys()) askedFor.current.delete(key)
      }
    })()
  }, [state.items, models, fetchProducts])

  // ---- staging from the basket and from a product page ------------------

  /**
   * Read the basket and park its contents in the tray.
   *
   * 'refresh' clears the current tray first and reads the basket again - the
   * shopper pressed the button because the basket changed under an open
   * planner. Placed items are never touched either way. Anything the basket
   * holds that can no longer be staged (a line since retired from the shop, a
   * quantity over the cap) is COUNTED AND SAID rather than silently dropped -
   * a tray that quietly loses things reads as the planner losing them.
   */
  const stageFromCart = useCallback(
    async (mode: 'initial' | 'refresh') => {
      const lines = readCart()
      const wanted = cartAsStagedItems()
      if (mode === 'initial' && wanted.length === 0) return
      // The tray gets no more than the layout can hold.
      //
      // Nothing capped this: a basket of two hundred lines at fifty each is ten
      // thousand items, built in the browser before anything is validated. The
      // item cap only bites server-side at save, and above roughly seventeen
      // hundred the payload size check fires FIRST - so the shopper's reward for
      // a big basket was a plain 413 instead of the carefully worded "take a few
      // out" the cap exists to give them, having already sat through a room that
      // had ground to a halt drawing furniture it was never going to keep.
      const room = Math.max(0, Math.min(props.maxItemsPerPlan, MAX_ITEMS) - placedCountRef.current)
      const staged = wanted.slice(0, room)
      const overflow = wanted.length - staged.length
      // One context request per distinct grouped line, so the desk staged with
      // its screens arrives as the combined model rather than the plain desk.
      const contextRequests = new Map<string, { productId: string; context: string; extraValueIds: string[] }>()
      for (const entry of staged) {
        if (!entry.modelContext) continue
        const key = `${entry.productId}@@${entry.modelContext.context}`
        if (!contextRequests.has(key)) {
          contextRequests.set(key, { productId: entry.productId, context: entry.modelContext.context, extraValueIds: entry.modelContext.extraValueIds })
        }
      }
      let items: Array<ProductInfo & { id: string }>
      try {
        items = await fetchProducts([...new Set(staged.map((entry) => entry.productId))], [...contextRequests.values()])
      } catch {
        // The shop did not answer. Said plainly, because the alternative - an
        // empty answer read as "none of this is sold any more" - told customers
        // their basket had been discontinued over a dropped connection.
        setTrayNote('')
        setMessage({ tone: 'error', text: 'We could not reach the shop to fetch your basket. Try the Cart tab again in a moment.' })
        return
      }
      const byId = new Map(items.map((item) => [item.id, item]))
      // Cleared by the reducer against the tray as it stands NOW. Working out
      // the ids here - before or after the request, it makes no difference -
      // reads them off this closure's copy of the state, so anything placed
      // while the request was in flight was still listed as waiting and the
      // refresh took it back out of the room.
      // basketOnly: re-reading the basket replaces what came FROM the basket and
      // leaves alone anything the tray is holding because a redrawn room could
      // no longer fit it. Committed first, so it is undoable either way.
      if (mode === 'refresh') {
        commit()
        dispatch({ type: 'clear-staged', basketOnly: true })
      }
      for (const entry of staged) {
        const info = byId.get(entry.productId)
        if (!info) continue
        dispatch({
          type: 'add-item', id: nextId(), product: { ...info, productId: info.id }, x: 0, y: 0, staged: true,
          modelContext: entry.modelContext ? { context: entry.modelContext.context, extraValueIds: entry.modelContext.extraValueIds } : null,
          basketLine: entry.basketLine,
          basketBundle: entry.basketBundle,
        })
      }
      const missing = new Set(staged.map((entry) => entry.productId).filter((id) => !byId.has(id))).size
      const clamped = lines.filter((line) => line.quantity > 50).length
      const notes: string[] = []
      if (missing > 0) {
        notes.push(
          missing === 1
            ? 'One thing from your basket is no longer sold, so it is not here.'
            : `${missing} things from your basket are no longer sold, so they are not here.`,
        )
      }
      if (clamped > 0) notes.push('Very large quantities come in as the first 50.')
      if (overflow > 0) {
        notes.push(
          `A layout holds ${Math.min(props.maxItemsPerPlan, MAX_ITEMS)} things, so ${overflow} from your basket are waiting for the next one. Your basket still has all of them.`,
        )
      }
      setTrayNote(notes.join(' '))
      setTab('tray')
    },
    // No state.items: the reducer resolves the waiting list against the tray as
    // it stands when the action lands, which is the whole point of clear-staged.
    // Depending on it here also rebuilt this callback on every furniture edit.
    [fetchProducts, nextId, commit, props.maxItemsPerPlan],
  )

  useEffect(() => {
    if (!props.stageCart || !started || stagedCartRef.current) return
    // Guarded by a ref, not by the effect's own dependencies. "once per mount"
    // was not true: Start again sets `started` back to false and the first-run
    // screen sets it true again, so the effect fired a second time and staged
    // the whole basket on top of the copy already waiting - twelve lines became
    // twenty-four. The product-page effect below has always had this guard.
    stagedCartRef.current = true
    void (async () => {
      await stageFromCart('initial')
    })()
    // Deliberately once: re-staging on every basket change would duplicate what
    // the shopper has already placed. The Cart tab's refresh button is the
    // deliberate version of the same thing.
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
      let info: (ProductInfo & { id: string }) | undefined
      try {
        ;[info] = await fetchProducts([wanted])
      } catch {
        setMessage({ tone: 'error', text: 'We could not fetch that one just now. Find it again under "Add things".' })
        return
      }
      // Said, not swallowed. The products route filters to ACTIVE, so a
      // product archived, drafted or deleted since somebody followed "See it in
      // your room" answered with an empty list and the shopper landed on a blank
      // first-run screen with no explanation at all. The basket path has counted
      // and named exactly this case from the start.
      if (!info) {
        setMessage({ tone: 'info', text: 'That product is not for sale any more, so there was nothing to put in the room. Everything else still works.' })
        return
      }
      const product = { ...info, productId: info.id }
      const spot = findFreeSpot(state.items, state.geometry, product)
      dispatch({ type: 'add-item', id: nextId(), product, x: spot.x, y: spot.y })
      if (!spot.clear) {
        setMessage({ tone: 'info', text: 'There was no clear floor left, so it went in on top of something - drag it somewhere free.' })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the first render after the room exists
  }, [props.stageProductId, started])

  // ---- scratch + unsaved-work guard ------------------------------------

  useEffect(() => {
    // Scratch is the safety net for work with nowhere else to live. A plan that
    // is already saved has somewhere - and writing it here would have "continue
    // where you left off" resurrect it on the next visit as if it were unsaved.
    if (!started || savedPlanId) return
    writeScratch(state.geometry, state.items, roomName)
  }, [state.geometry, state.items, started, savedPlanId, roomName])

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

  // What the catalogue knows about the space under each product's top. Without
  // it the clash warning cannot tell a chair pushed under a desk - which is the
  // arrangement people are aiming for - from two desks in the same square metre.
  const underTop = useMemo(() => {
    const out: Record<string, { heightMm: number | null; widthMm: number | null }> = {}
    for (const [id, info] of Object.entries(products)) {
      out[id] = { heightMm: info.underTopHeightMm, widthMm: info.underTopWidthMm }
    }
    return out
  }, [products])

  const clashes = useMemo(() => findClashes(state.items, underTop, state.geometry), [state.items, underTop, state.geometry])
  /**
   * The items involved in a clash, each once - what the warning counts and
   * selects.
   *
   * `b` is the sentinel 'obstruction' where the other party is a column rather
   * than a second item, so it is filtered out: counting it made one desk in a
   * pillar read as "2 things are overlapping", and selecting it left the panel
   * claiming two selected over a list of one.
   */
  const clashingIds = useMemo(
    () => [...new Set(clashes.flatMap((pair) => [pair.a, pair.b]).filter((id) => id !== CLASH_WITH_OBSTRUCTION))],
    [clashes],
  )
  const clashCount = clashingIds.length
  const clashSentence =
    clashCount === 1
      ? 'One thing is overlapping something else. A chair tucked under a desk is fine; two desks in the same spot is not.'
      : `${clashCount} things are overlapping something else. A chair tucked under a desk is fine; two desks in the same spot is not.`
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
    for (const [key, model] of models) {
      resolved.set(key, {
        // The map is keyed `productId@@context` for a combined variant, so the
        // key is not the product id and must not be stored as one. Nothing reads
        // this field today, which is exactly how it would go unnoticed until
        // something did.
        productId: model.productId,
        plainUrl: model.cacheKey,
        format: model.format as ResolvedModel['format'],
        yawOffsetDeg: model.yawOffsetDeg,
        noDecimation: model.noDecimation,
        fabricKey: model.fabricKey ?? '',
      })
    }
    return buildScene(state.geometry, { version: PLAN_SCHEMA_VERSION, items: state.items }, snapshot, resolved)
    // The two fields the scene is actually built from, rather than the whole
    // state. `select` returns a new state object - it has to - so selecting
    // anything while Preview was open rebuilt this description, which tore the
    // entire 3D scene down and built it again: every model re-cloned, every
    // placeholder re-made, every product photo re-requested, behind "Putting the
    // room together…". Tapping a line in the item list to find it in the room,
    // or pressing "Show me what is overlapping", cost a full rebuild for a
    // change the scene does not contain.
  }, [state.geometry, state.items, snapshot, models])

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

  // Everything in the room, by product, companions included - the same rule the
  // PDF, the email and the quote price against. Counting placed items alone put
  // a different total on screen from the one on the paperwork for any desk
  // bought with its screens.
  const roomCounts = useMemo(() => countPlanProducts(state.items), [state.items])

  // What the room adds up to, kept in the shopper's eyeline rather than two
  // taps away on the Item list tab. This is a shopping tool: the running total
  // is the number every decision in it is being made against, and hiding it
  // behind a tab turned "can we afford a twelfth desk" into a detour. Zero when
  // nothing priced is down yet, and the header simply says nothing.
  const placedTotal = useMemo(() => {
    let total = 0
    for (const [productId, quantity] of roomCounts) total += (products[productId]?.price ?? 0) * quantity
    return total
  }, [roomCounts, products])

  // Whether anything in the room is priced "from" - a listing whose variations
  // carry their own prices. The header total says so too, or it states a figure
  // this shop has not agreed to.
  const totalIsFrom = useMemo(
    () => [...roomCounts.keys()].some((productId) => products[productId]?.priceVaries),
    [roomCounts, products],
  )

  /**
   * The 3D view has measured a model whose plan size was a guess. Adopt the
   * mesh's footprint, so the flat plan and the 3D view tell one story about how
   * big the thing is. Not an undo step - nothing the shopper did - and only for
   * sizes still on a fallback, so a hand-typed size is never overwritten. The
   * patch flips sizeSource to 'glb', which is what stops the next scene build
   * reporting the same item again.
   */
  const adoptMeasuredSizes = useCallback(
    (measured: Array<{ itemId: string; productId: string; widthMm: number; depthMm: number; heightMm: number }>) => {
      for (const entry of measured) {
        const item = state.items.find((candidate) => candidate.id === entry.itemId)
        if (!item || item.manualSize) continue
        if (item.sizeSource !== 'marker' && item.sizeSource !== 'category_default') continue
        const differs =
          Math.abs(item.widthMm - entry.widthMm) > 1 ||
          Math.abs(item.depthMm - entry.depthMm) > 1 ||
          Math.abs(item.heightMm - entry.heightMm) > 1
        if (!differs) continue
        dispatch({
          type: 'set-item',
          id: item.id,
          patch: { widthMm: entry.widthMm, depthMm: entry.depthMm, heightMm: entry.heightMm, sizeSource: 'glb' },
        })
      }
    },
    [state.items],
  )

  // How many of each product are in the room, rolled up to the LISTING as well:
  // the browse panel shows family cards, so a placed variant counts against the
  // card the shopper actually taps.
  const placedCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of placed) {
      counts[item.productId] = (counts[item.productId] ?? 0) + 1
      const parentId = products[item.productId]?.parentId
      if (parentId) counts[parentId] = (counts[parentId] ?? 0) + 1
    }
    return counts
  }, [placed, products])

  // ---- actions ----------------------------------------------------------

  /**
   * Put a specific product in the room.
   *
   * Takes the product rather than the card because a card is a family and a
   * family is not placeable: the browse panel resolves a listing to the exact
   * variation the shopper picked, at its own size, and hands one of these over.
   */
  const placeProduct = useCallback(
    (info: ProductInfo, quantity = 1) => {
      commit()
      setProducts((current) => ({ ...current, [info.productId]: info }))
      // Spots are found against a running copy: the state does not move between
      // dispatches inside one click, so without this every instance of a
      // quantity would be offered the same free spot and land in a pile.
      const count = Math.max(1, Math.min(20, Math.round(quantity)))
      let working: SpotItem[] = state.items
      let crowded = false
      for (let index = 0; index < count; index += 1) {
        const spot = findFreeSpot(working, state.geometry, info)
        if (!spot.clear) crowded = true
        dispatch({ type: 'add-item', id: nextId(), product: info, x: spot.x, y: spot.y })
        working = [...working, { x: spot.x, y: spot.y, yaw: 0, widthMm: info.widthMm, depthMm: info.depthMm }]
      }
      if (crowded) {
        setMessage({ tone: 'info', text: 'There was no clear floor left, so it went in on top of something - drag it somewhere free.' })
      }
      // What was handed over carries enough to draw the thing at once, which is
      // why it is used above - but it may have no model and no under-desk
      // measurements. Asking for those here rather than leaving it to the
      // missing-products effect, because that effect looks for products it has
      // never heard of and the line above has just introduced this one. Without
      // it, placing from the browse panel drew a labelled box for a product
      // whose card said "3D".
      void fetchProducts([info.productId]).catch(() => {
        // The optimistic version stands. A model that never arrives is a
        // placeholder, which is the main path for most of the catalogue anyway.
      })
    },
    [commit, nextId, state.geometry, state.items, fetchProducts],
  )

  /** A card with nothing to choose from: one product, straight in. */
  const place = useCallback(
    (card: CatalogueCard) => {
      placeProduct({
        productId: card.id,
        name: card.name,
        image: card.image,
        priceFormatted: card.priceFormatted,
        price: card.price,
        parentId: null,
        widthMm: card.widthMm,
        depthMm: card.depthMm,
        heightMm: card.heightMm,
        sizeSource: card.approximateSize ? 'category_default' : 'attribute',
        mount: 'floor',
        underTopHeightMm: null,
        underTopWidthMm: null,
      })
    },
    [placeProduct],
  )

  /** One thing out of the waiting list and into the room, at a free spot. */
  const placeFromTray = useCallback(
    (id: string) => {
      const item = state.items.find((entry) => entry.id === id)
      if (!item) return
      commit()
      const spot = findFreeSpot(state.items, state.geometry, item)
      dispatch({ type: 'unstage-item', id, x: spot.x, y: spot.y })
      if (!spot.clear) {
        setMessage({ tone: 'info', text: 'There was no clear floor left, so it went in on top of something - drag it somewhere free.' })
      }
    },
    [commit, state.geometry, state.items],
  )

  /**
   * Everything waiting, into the room in one go.
   *
   * The spots are worked out against a running copy of the items rather than the
   * state, because the state does not move between dispatches inside one click -
   * asked one at a time, every item would be offered the same free spot and the
   * lot would land in a pile.
   */
  const placeAllFromTray = useCallback(() => {
    commit()
    let working = state.items
    let crowded = false
    for (const item of state.items) {
      if (!item.staged) continue
      const spot = findFreeSpot(working, state.geometry, item)
      if (!spot.clear) crowded = true
      working = working.map((entry) => (entry.id === item.id ? { ...entry, staged: false, x: spot.x, y: spot.y } : entry))
      dispatch({ type: 'unstage-item', id: item.id, x: spot.x, y: spot.y })
    }
    if (crowded) {
      setMessage({ tone: 'info', text: 'The room ran out of clear floor, so some things are on top of each other - drag them apart.' })
    }
  }, [commit, state.geometry, state.items])

  /** Off the waiting list without going into the room - a change of mind. */
  const removeFromTray = useCallback(
    (id: string) => {
      commit()
      dispatch({ type: 'delete-items', ids: [id] })
    },
    [commit],
  )

  /**
   * The tab actually shown. Derived rather than synced, because the waiting tab
   * only exists while something is waiting: however the list empties - placed
   * one by one, placed all at once, taken off, or a saved plan loaded over the
   * top - the panel falls back to browsing without an effect chasing the state.
   * And if reshaping the room puts something back on the list, the panel is
   * already looking at it.
   */
  const activeTab: Tab = tab === 'tray' && tray.length === 0 ? 'catalogue' : tab

  const applyStep = useCallback(
    (step: { history: History; snapshot: { geometry: RoomGeometry; items: PlanItem[] } } | null) => {
      if (!step) return
      setHistory(step.history)
      dispatch({ type: 'load', snapshot: step.snapshot })
      setDirty(true)
    },
    [],
  )

  /**
   * Off to sign in, without the browser asking whether they meant it.
   *
   * The unsaved-work guard fires on any navigation while `dirty`, so pressing
   * Save as a signed-out visitor produced the browser's own "Leave site?"
   * dialog - and choosing "Stay" left them looking at a note about making an
   * account with nothing to click. The work is in the browser's scratch copy
   * either way, which is what makes dropping the flag honest rather than
   * convenient: it is already kept, and it comes back after signing in.
   */
  const goSignIn = useCallback(() => {
    setDirty(false)
    // In a microtask, so React has committed the flag - and with it removed the
    // beforeunload listener - before the navigation starts.
    queueMicrotask(() => {
      window.location.href = `${props.signInHref}?next=${encodeURIComponent('/space-planner')}`
    })
  }, [props.signInHref])

  /**
   * Save the room and the layout, and answer with the plan's id.
   *
   * The id matters to more than the save button now: anything that has to happen
   * server-side against this plan - the PDF, a quote, a picture - needs the plan
   * to exist first, and needs to know what it was called when it did.
   *
   * `quiet` suppresses the "saved" note for callers that are saving on the way
   * to doing something else, where "Saved." is an answer to a question nobody
   * asked.
   */
  const savePlan = useCallback(async (opts: { quiet?: boolean } = {}): Promise<string | null> => {
    if (!props.signedIn) {
      goSignIn()
      return null
    }
    // One save at a time. Two clicks of Save in quick succession both saw "no
    // room yet" and each made one - the member ended up with two identical
    // spaces and their layout filed under whichever finished second.
    if (savingRef.current) return null
    savingRef.current = true
    setMessage(null)
    try {
      let roomId = savedRoomId
      if (!roomId) {
        const roomResponse = await fetch('/api/m/space-planner-for-shop/member/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: roomName, notes: '', geometry: state.geometry }),
        })
        const roomData = (await roomResponse.json().catch(() => null)) as SaveFailure & { room?: { id: string } } | null
        if (!roomResponse.ok || !roomData?.room) throw await saveError(roomResponse, roomData, 'space')
        roomId = roomData.room.id
        setSavedRoomId(roomId)
        roomIdRef.current = roomId
      } else {
        const roomResponse = await fetch(`/api/m/space-planner-for-shop/member/rooms/${roomId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: roomName, notes: '', geometry: state.geometry }),
        })
        // Checked, not assumed. This response used to be dropped on the floor,
        // so a refused room update - the walls, the doors, the columns - saved
        // the furniture over the OLD room and told the shopper all was well.
        if (!roomResponse.ok) {
          const roomData = (await roomResponse.json().catch(() => null)) as SaveFailure | null
          throw await saveError(roomResponse, roomData, 'space')
        }
      }

      const body = JSON.stringify({ name: planName, items: toPlanItems(state) })
      const planResponse = savedPlanId
        ? await fetch(`/api/m/space-planner-for-shop/member/plans/${savedPlanId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
        : await fetch(`/api/m/space-planner-for-shop/member/rooms/${roomId}/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })

      const planData = (await planResponse.json().catch(() => null)) as SaveFailure & { plan?: { id: string } } | null
      if (!planResponse.ok || !planData?.plan) throw await saveError(planResponse, planData, 'layout')

      setSavedPlanId(planData.plan.id)
      setDirty(false)
      clearScratch()
      if (!opts.quiet) setMessage({ tone: 'info', text: 'Saved. You will find it under "My spaces" in your account.' })
      return planData.plan.id
    } catch (error) {
      // A session that expired while the tab was open is a sign-in prompt, not
      // an error message: props.signedIn was rendered on the server and has no
      // idea. Without this the shopper read "Sign in to save your plans." as a
      // red alert with nothing to click.
      if (error instanceof NeedsSignIn) {
        goSignIn()
        return null
      }
      // Forget the dead id, so the advice in the message is true by the time
      // they read it. A layout that has gone does not take its room with it -
      // the room may be perfectly fine - so only the one that 404ed is dropped.
      if (error instanceof SavedCopyGone) {
        if (error.what === 'space') {
          setSavedRoomId(null)
          roomIdRef.current = null
        }
        setSavedPlanId(null)
      }
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'We could not save that just now.' })
      return null
    } finally {
      savingRef.current = false
    }
  }, [props.signedIn, goSignIn, savedPlanId, savedRoomId, state, roomName, planName])

  /**
   * Give the room a different name.
   *
   * Written through at once when the room already exists on the server rather
   * than waiting for the next Save: somebody who renames a room, sees the new
   * name and closes the tab has every reason to expect it to still be there.
   * A room that has never been saved has nowhere to write to, so its new name
   * simply travels with the first save along with everything else.
   */
  const renameRoom = useCallback(
    (typed: string) => {
      const name = typed.trim().slice(0, 120)
      if (!name || name === roomName) return
      setRoomName(name)
      const roomId = roomIdRef.current
      if (!roomId || !props.signedIn) {
        setDirty(true)
        return
      }
      void (async () => {
        try {
          const response = await fetch(`/api/m/space-planner-for-shop/member/rooms/${roomId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            // The name and nothing else. Notes are left out because the route
            // treats an absent one as "leave it alone" and a rename has no
            // business clearing what somebody wrote about the room - and the
            // GEOMETRY is left out for a sharper reason: sending it committed
            // whatever the browser was holding, so a wall dragged and not yet
            // saved was written to the server by typing a new name, taking the
            // furniture in every other layout in the room with it.
            body: JSON.stringify({ name }),
          })
          if (!response.ok) throw new Error('the rename was refused')
        } catch {
          // The name stands on screen. Marking it unsaved is the honest answer:
          // Save will carry it, and the unsaved-work guard now knows to ask.
          setDirty(true)
          setMessage({ tone: 'error', text: 'The new name is here but we could not keep it just yet - press Save.' })
        }
      })()
    },
    [roomName, props.signedIn],
  )

  // ---- saved viewpoints ---------------------------------------------------

  // What is already saved against this room. Only ever for a room that exists:
  // a scratch room in localStorage has no id to hang a viewpoint off, and the
  // save button is the sign-in prompt exactly as it is everywhere else here.
  useEffect(() => {
    if (!savedRoomId || !props.signedIn) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`/api/m/space-planner-for-shop/member/rooms/${savedRoomId}/views`)
        if (!response.ok) return
        const data = (await response.json()) as { views?: SplRoomView[] }
        if (!cancelled) setViews(data.views ?? [])
      } catch {
        // Not news. The planner works without saved views and says so by simply
        // not offering any.
      }
    })()
    return () => { cancelled = true }
  }, [savedRoomId, props.signedIn])

  /**
   * Keep where you are standing.
   *
   * Saves the plan first, and not merely to be tidy: the viewpoint belongs to a
   * room, so an unsaved scratch room has nothing to attach it to. For a signed
   * out visitor that first step is the sign-in prompt, which is the same bargain
   * the rest of the planner makes.
   */
  const saveCurrentView = useCallback(async () => {
    const camera = cameraProbe.current?.()
    if (!camera) return
    setViewsBusy(true)
    try {
      const planId = await savePlan({ quiet: true })
      if (!planId) return
      const roomId = roomIdRef.current
      if (!roomId) throw new Error('Could not work out which space this is.')

      const response = await fetch(`/api/m/space-planner-for-shop/member/rooms/${roomId}/views`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `View ${views.length + 1}`, camera }),
      })
      const data = (await response.json()) as { view?: SplRoomView; error?: string }
      if (!response.ok || !data.view) throw new Error(data.error ?? 'We could not keep that view.')
      setViews((current) => [...current, data.view as SplRoomView])
      setMessage({ tone: 'info', text: 'View kept. Rename it in the list, or use it for a photograph.' })
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'We could not keep that view.' })
    } finally {
      setViewsBusy(false)
    }
  }, [savePlan, views.length])

  const renameView = useCallback(async (viewId: string, name: string) => {
    const roomId = roomIdRef.current
    if (!roomId) return
    // Shown immediately and corrected if the server disagrees. Renaming a view is
    // not the sort of thing anybody should watch a spinner for.
    setViews((current) => current.map((view) => (view.id === viewId ? { ...view, name } : view)))
    try {
      await fetch(`/api/m/space-planner-for-shop/member/rooms/${roomId}/views/${viewId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
    } catch {
      // Left as typed. The next load reads the server's answer.
    }
  }, [])

  /** Re-point a saved view at where the camera is standing now. */
  const updateViewCamera = useCallback(async (viewId: string) => {
    const camera = cameraProbe.current?.()
    const roomId = roomIdRef.current
    if (!camera || !roomId) return
    setViews((current) => current.map((view) => (view.id === viewId ? { ...view, camera } : view)))
    try {
      await fetch(`/api/m/space-planner-for-shop/member/rooms/${roomId}/views/${viewId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera }),
      })
      setMessage({ tone: 'info', text: 'That view now points where you are looking.' })
    } catch {
      setMessage({ tone: 'error', text: 'We could not move that view just now.' })
    }
  }, [])

  const deleteView = useCallback(async (viewId: string) => {
    const roomId = roomIdRef.current
    if (!roomId) return
    setViews((current) => current.filter((view) => view.id !== viewId))
    try {
      await fetch(`/api/m/space-planner-for-shop/member/rooms/${roomId}/views/${viewId}`, { method: 'DELETE' })
    } catch {
      // Gone from the list either way; the next load is the arbiter.
    }
  }, [])

  /** Stand where a saved view stands. Switches to the 3D tab, since that is the
   * only place a camera pose means anything. */
  const goToView = useCallback((view: SplRoomView) => {
    setStage('orbit')
    setPerspective(view.camera.projection === 'perspective')
    setRestore({ camera: view.camera, nonce: Date.now() })
  }, [])

  // ---- the room's own outline -------------------------------------------

  /**
   * A new outline, live from the canvas.
   *
   * Validation happens on settle, never mid-drag: telling somebody their walls
   * cross while their finger is still moving through the position where they
   * briefly do is nagging, not helping. On release an outline that folds through
   * itself is refused and the previous one is put back - which is why the undo
   * snapshot is taken at the start of the gesture rather than at the end of it.
   */
  const applyShape = useCallback(
    (vertices: Vertex[], settle: boolean) => {
      if (!settle) {
        // One undo step per gesture, banked on the first move of it. Nothing
        // used to bank one at all, so the refusal below reached for an undo
        // snapshot that either did not exist or belonged to something else
        // entirely - and a room refused for folding through itself stayed on
        // screen folded through itself.
        if (!shapeBeforeEdit.current) {
          shapeBeforeEdit.current = state.geometry
          commit()
        }
        dispatch({ type: 'set-shape', vertices, settle: false })
        return
      }

      // A settle with no gesture behind it is a one-shot edit - a corner added
      // by double-tapping, or one removed - so its undo step is banked here.
      const previous = shapeBeforeEdit.current
      if (!previous) commit()
      const restore = previous ?? state.geometry
      shapeBeforeEdit.current = null

      const candidate = { ...state.geometry, vertices }
      const issues = validateRoomGeometry(candidate).filter(
        (issue) => issue.code === 'self-intersecting' || issue.code === 'wall-too-short' || issue.code === 'not-a-number',
      )
      if (issues.length > 0) {
        setMessage({ tone: 'error', text: issues[0]?.message ?? 'That shape will not work.' })
        // Put back the outline that was there when the gesture started. The
        // furniture stays exactly as it is: nothing about it was in question.
        dispatch({ type: 'load', snapshot: { geometry: restore, items: state.items } })
        return
      }
      setMessage(null)
      dispatch({ type: 'set-shape', vertices, settle: true })
      setDirty(true)
    },
    [commit, state],
  )

  const startDrawing = useCallback(() => {
    commit()
    shapeBeforeDraw.current = state.geometry
    setRoomEdit(false)
    setStage('plan')
    setPlanMode('draw')
    setMessage({ tone: 'info', text: 'Tap each corner of the room in turn, then tap the first one again to close it.' })
  }, [commit, state.geometry])

  const finishDrawing = useCallback(
    (vertices: Vertex[]) => {
      const candidate = { ...state.geometry, vertices }
      const issues = validateRoomGeometry(candidate).filter((issue) => issue.code !== 'obstruction-outside' && issue.code !== 'opening-off-wall' && issue.code !== 'opening-too-wide')
      if (issues.length > 0) {
        setMessage({ tone: 'error', text: issues[0]?.message ?? 'That shape will not work.' })
        return
      }
      dispatch({ type: 'set-shape', vertices, settle: true })
      shapeBeforeDraw.current = null
      setPlanMode('furnish')
      setDirty(true)
      setMessage({ tone: 'info', text: 'There is your room. Click any wall to type its exact length.' })
    },
    [state.geometry],
  )

  const cancelDrawing = useCallback(() => {
    const previous = shapeBeforeDraw.current
    shapeBeforeDraw.current = null
    setPlanMode('furnish')
    if (previous) dispatch({ type: 'set-geometry', geometry: previous })
    setMessage(null)
  }, [])

  /**
   * Export the plan as a PDF.
   *
   * The two drawings are photographed HERE, in the tab, because they are
   * pictures of what the shopper is actually looking at - their zoom, their
   * angle. The 3D one needs its view to exist, so if they have never opened
   * Preview it is opened for them, given a moment to build, photographed and put
   * back. Fiddly, but the alternative is a tick box that silently produces a
   * document with a missing picture in it.
   *
   * A PDF is made from the SAVED plan, so an unsaved one is saved on the way -
   * the document has to price the items server-side, and the shop's own prices
   * are the only ones it is allowed to print.
   */
  const exportPdf = useCallback(
    async (options: { includePlanView: boolean; include3dView: boolean; includeQuote: boolean; viewIds: string[] }) => {
      setExportBusy(true)
      setExportStep('Getting the room ready…')
      setMessage(null)
      const stageBefore = stage
      const perspectiveBefore = perspective
      try {
        if (!props.signedIn) {
          goSignIn()
          return
        }

        // The 3D ones first: they have models to fetch and frames to draw, and
        // waiting for them is the long part.
        let viewImage: string | null = null
        if (options.include3dView) {
          setExportStep('Photographing the 3D view…')
          setStage('orbit')
          viewImage = await waitForCapture(captureView, () => !viewBusy.current)
        }

        // Each ticked saved view: stand the camera on it, give the frame a
        // moment to settle, photograph it. Where the shopper was standing is
        // read first and put back afterwards - an export should not end with
        // the camera parked wherever the last picture happened to be taken.
        const savedViews: Array<{ name: string; image: string }> = []
        const wanted = options.viewIds
          .map((viewId) => views.find((view) => view.id === viewId))
          .filter((view): view is SplRoomView => Boolean(view))
        if (wanted.length > 0) {
          const cameraBefore = cameraProbe.current?.() ?? null
          setStage('orbit')
          for (const view of wanted) {
            setPerspective(view.camera.projection === 'perspective')
            setRestore({ camera: view.camera, nonce: Date.now() })
            await delay(350)
            const image = await waitForCapture(captureView, () => !viewBusy.current)
            if (image) savedViews.push({ name: view.name, image })
          }
          setPerspective(perspectiveBefore)
          if (cameraBefore) setRestore({ camera: cameraBefore, nonce: Date.now() + 1 })
        }

        let planImage: string | null = null
        if (options.includePlanView) {
          setStage('plan')
          planImage = await waitForCapture(capturePlan)
        }

        // What was asked for and did not come out. A picture that fails to
        // photograph itself simply used to be absent from the document, with no
        // mention of it anywhere - so somebody who ticked "the 3D view", waited
        // for it, and got a PDF without one had no way of telling whether they
        // had ticked it at all.
        const missingPictures: string[] = []
        if (options.include3dView && !viewImage) missingPictures.push('the 3D view')
        if (options.includePlanView && !planImage) missingPictures.push('the floor plan')
        const missingViews = wanted.length - savedViews.length
        if (missingViews > 0) missingPictures.push(missingViews === 1 ? 'one of your saved views' : `${missingViews} of your saved views`)

        setExportStep('Saving your layout…')
        const planId = await savePlan({ quiet: true })
        if (!planId) return

        setExportStep('Putting the document together…')

        const response = await fetch(`/api/m/space-planner-for-shop/member/plans/${planId}/pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            includePlanView: options.includePlanView,
            include3dView: options.include3dView,
            includeQuote: options.includeQuote,
            planImage,
            viewImage,
            views: savedViews,
          }),
        })
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(data?.error ?? 'We could not make that PDF just now.')
        }

        // Handed to the browser as a download rather than opened in a tab: this
        // is a document somebody wants to keep and send on.
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `${roomName} - ${planName}.pdf`.replace(/[^A-Za-z0-9 ._-]+/g, '')
        document.body.appendChild(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
        setExporting(false)
        if (missingPictures.length > 0) {
          setMessage({
            tone: 'info',
            text: `Your PDF is here, but ${missingPictures.join(' and ')} would not come out - the measurements and the item list are all there.`,
          })
        }
      } catch (error) {
        setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'We could not make that PDF just now.' })
      } finally {
        // Put the workspace back whatever happened. The restores used to sit on
        // the success path only, so a capture that threw left the shopper
        // staring at whichever view the export had flicked to, in whichever
        // projection the last ticked viewpoint wore.
        setStage(stageBefore)
        setPerspective(perspectiveBefore)
        setExportBusy(false)
        setExportStep('')
      }
    },
    [props.signedIn, goSignIn, savePlan, stage, perspective, views, roomName, planName],
  )

  const sendToCart = useCallback(() => {
    // Instances merge by the LINE they stand for, not the bare product: two
    // identically-configured desks-with-screens become one line of two (their
    // companions scaled to match), while a desk saved with different add-ons
    // stays its own line. Items with no snapshot key by product id, as ever.
    const grouped = new Map<string, { line: (typeof placed)[number]; quantity: number }>()
    for (const item of placed) {
      const key = item.basketLine?.lineId ?? item.productId
      const entry = grouped.get(key)
      if (entry) entry.quantity += 1
      else grouped.set(key, { line: item, quantity: 1 })
    }
    const result = addPlanToCart([...grouped.values()].map(({ line, quantity }) => ({
      productId: line.productId,
      quantity,
      basketLine: line.basketLine ?? null,
      basketBundle: line.basketBundle ?? null,
    })))
    setMessage(
      result.ok
        ? result.added === 0
          ? // Nothing to do, said as such. This is the ordinary answer for
            // somebody who came in from the basket and planned the room without
            // changing what was in it - and "0 things added to your basket"
            // reads as a failure when it is the opposite.
            { tone: 'info', text: 'Your basket already holds everything in this room.' }
          : { tone: 'info', text: `${result.added === 1 ? 'One thing' : `${result.added} things`} added to your basket.` }
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
        setStartAgain(false)
        // A column picked out on the plan takes the toolbar over while it is
        // selected, so there has to be a key that hands the toolbar back.
        setObstructionSelection(null)
        setOpeningSelection(null)
        // And the room-editing modes themselves: Escape is the universal "out",
        // and a mode with no keyboard exit strands anybody who found Doors &
        // windows and lost the Done button under the message that opened it.
        if (planMode === 'draw') cancelDrawing()
        else if (planMode !== 'furnish') setPlanMode('furnish')
        // The photo dialog says in its own wording that closing it abandons
        // nothing, so Escape may always close it. The export dialog is only
        // held open while a PDF is actually being made - closing it then would
        // leave the download to arrive into a page with no sign it was coming.
        setExporting(false)
        setPhotos(false)
        setMoreOpen(false)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        applyStep(event.shiftKey ? redo(history, state) : undo(history, state))
        return
      }
      // A selected column answers to Delete like anything else selected does.
      // Before the bail below, because picking a column clears the furniture
      // selection - the two are never both the thing being edited.
      if (obstructionSelection && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault()
        commit()
        dispatch({ type: 'delete-obstruction', id: obstructionSelection })
        setObstructionSelection(null)
        setDirty(true)
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
  }, [state, history, commit, applyStep, exportBusy, obstructionSelection, planMode, cancelDrawing])

  // A confirmation is read once; an instruction is read for as long as the job
  // takes. So the passing notes - "Saved.", "added to your basket", the
  // no-clear-floor warning - take themselves away, and anything shown while the
  // room itself is being edited stays put, because that is the mode whose
  // messages are directions rather than news. Errors always stay: they name
  // something that needs doing.
  useEffect(() => {
    if (!message || message.tone !== 'info' || planMode !== 'furnish') return
    const timer = setTimeout(() => setMessage(null), 8000)
    return () => clearTimeout(timer)
  }, [message, planMode])

  // ---- render -----------------------------------------------------------

  if (!started) {
    return (
      <div className="spl-root spl-root-intro">
        <style dangerouslySetInnerHTML={{ __html: plannerCss() }} />
        <FirstRun
          heading={props.heading}
          intro={props.intro}
          fromCart={Boolean(props.stageCart)}
          savedRooms={props.savedRooms ?? []}
          signedIn={props.signedIn}
          signInHref={props.signInHref}
          onReady={(geometry) => {
            dispatch({ type: 'set-geometry', geometry })
            setStarted(true)
          }}
          onDraw={() => {
            setStarted(true)
            setPlanMode('draw')
            setMessage({ tone: 'info', text: 'Tap each corner of the room in turn, then tap the first one again to close it.' })
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
          {/* Which room this is. A member with a ground floor and a first floor
              cannot tell one screenful of desks from the other otherwise, and
              the name is what every PDF, photograph and saved layout is filed
              under - so it belongs in front of them, not buried in a save. */}
          <div className="spl-room-name">
            {namingRoom ? (
              <input
                className="spl-input spl-name-input"
                defaultValue={roomName}
                autoFocus
                maxLength={120}
                aria-label="Room name"
                onBlur={(event) => {
                  if (!nameAbandoned.current) renameRoom(event.target.value)
                  nameAbandoned.current = false
                  setNamingRoom(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') {
                    nameAbandoned.current = true
                    event.currentTarget.blur()
                  }
                }}
              />
            ) : (
              <>
                {/* The name is ellipsised, so the full one has to be readable
                    somewhere. The rename button's label carries it for screen
                    readers; this is the same courtesy for everybody else. */}
                <span className="spl-room-name-text" title={roomName}>{roomName}</span>
                <button
                  type="button"
                  className="spl-name-edit"
                  aria-label={`Rename this room, currently called ${roomName}`}
                  onClick={() => setNamingRoom(true)}
                >
                  <span aria-hidden="true">✎</span>
                </button>
              </>
            )}
          </div>
          <span className="spl-sub">
            {areaM2.toFixed(1)} m² · {placed.length} {placed.length === 1 ? 'item' : 'items'}
            {placedTotal > 0 && ` · roughly ${totalIsFrom ? 'from ' : ''}${formatMoney(placedTotal, props.currencySymbol)}`}
            {tray.length > 0 && ` · ${tray.length} waiting`}
          </span>
        </div>
        <div className="spl-bar-spacer" />
        <div className="spl-tabs" role="tablist" aria-label="View">
          {(['plan', 'orbit'] as StageView[]).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              className="spl-tab"
              // Declared as tabs since the first release with nothing to point
              // at: no aria-controls here and no tabpanel on the stage, so a
              // screen reader announced a relationship that did not exist. The
              // side-panel tablist below has always wired both ends.
              id={`spl-view-tab-${option}`}
              aria-controls="spl-view-stage"
              aria-selected={stage === option}
              onClick={() => {
                setStage(option)
                if (option !== 'plan') setPlanMode('furnish')
              }}
            >
              {VIEW_LABELS[option]}
            </button>
          ))}
        </div>
        {stage === 'orbit' && (
          <label className="spl-check spl-bar-check">
            <input type="checkbox" checked={perspective} onChange={(event) => setPerspective(event.target.checked)} />
            <span>Perspective</span>
          </label>
        )}
        {planMode === 'openings' ? (
          <OpeningsBar
            geometry={state.geometry}
            kind={openingKind}
            onKind={setOpeningKind}
            selection={openingSelection}
            onPatch={(patch) => {
              if (!openingSelection) return
              commit()
              dispatch({ type: 'set-opening', id: openingSelection, patch })
              setDirty(true)
            }}
            onRemove={() => {
              if (!openingSelection) return
              commit()
              dispatch({ type: 'delete-opening', id: openingSelection })
              setOpeningSelection(null)
              setDirty(true)
            }}
            onDone={() => { setOpeningSelection(null); setPlanMode('furnish') }}
          />
        ) : planMode === 'obstructions' || (planMode === 'furnish' && obstructionSelection) ? (
          // Also while merely furnishing, when a column has been clicked on the
          // plan: clicking a thing and being shown what can be done with it is
          // the whole of a selection, and sending somebody back through Room to
          // change a column they are looking at is not a selection at all.
          <ObstructionsBar
            geometry={state.geometry}
            selection={obstructionSelection}
            onPatch={(patch) => {
              if (!obstructionSelection) return
              commit()
              dispatch({ type: 'set-obstruction', id: obstructionSelection, patch })
              setDirty(true)
            }}
            onRemove={() => {
              if (!obstructionSelection) return
              commit()
              dispatch({ type: 'delete-obstruction', id: obstructionSelection })
              setObstructionSelection(null)
              setDirty(true)
            }}
            onDone={() => { setObstructionSelection(null); setPlanMode('furnish') }}
          />
        ) : planMode !== 'furnish' ? (
          <div className="spl-bar-actions">
            <span className="spl-note">{planMode === 'draw' ? 'Drawing the room' : 'Changing the shape'}</span>
            {planMode === 'draw' ? (
              <button type="button" className="spl-btn" onClick={cancelDrawing}>
                Cancel
              </button>
            ) : (
              <button type="button" className="spl-btn spl-btn-primary" onClick={() => setPlanMode('furnish')}>
                Done with the room
              </button>
            )}
          </div>
        ) : (
        <div className={moreOpen ? 'spl-bar-actions is-open' : 'spl-bar-actions'}>
          <button
            type="button"
            className="spl-btn spl-more-toggle"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            {moreOpen ? 'Fewer' : 'More'}
          </button>
          <button type="button" className="spl-btn spl-secondary" onClick={() => setRoomEdit(true)}>
            Room
          </button>
          <button type="button" className="spl-btn spl-secondary" onClick={() => setStartAgain(true)}>
            Start again
          </button>
          <span className="spl-bar-sep spl-secondary" aria-hidden="true" />
          <button type="button" className="spl-btn spl-secondary" onClick={() => applyStep(undo(history, state))} disabled={history.past.length === 0}>
            Undo
          </button>
          <button type="button" className="spl-btn spl-secondary" onClick={() => applyStep(redo(history, state))} disabled={history.future.length === 0}>
            Redo
          </button>
          <span className="spl-bar-sep spl-secondary" aria-hidden="true" />
          <button type="button" className="spl-btn spl-secondary" onClick={() => setExporting(true)}>
            Export PDF
          </button>
          {props.rendersAvailable && (
            <button
              type="button"
              className="spl-btn spl-secondary"
              onClick={() => {
                // Read where they are standing NOW, at the moment they ask.
                // The 3D view unmounts when the flat plan is showing, so a probe
                // called later from inside the dialog would find nothing and
                // silently fall back to the canned angle.
                setPhotoCamera(cameraProbe.current?.() ?? null)
                setPhotos(true)
              }}
            >
              Make a photo
            </button>
          )}
          <span className="spl-bar-sep spl-secondary" aria-hidden="true" />
          <button type="button" className="spl-btn" onClick={sendToCart} disabled={placed.length === 0}>
            Add to basket
          </button>
          <button type="button" className="spl-btn spl-btn-primary" onClick={() => void savePlan()}>
            {props.signedIn ? 'Save' : 'Save (sign in)'}
          </button>
        </div>
        )}
      </div>

      {/* Two regions, both permanently mounted, and neither of them ever changes
          its politeness.
          Mounted because a live region that arrives at the same moment as its
          text is one most screen readers never announce - which is why "Saved.",
          "added to your basket" and every error were silent to anybody not
          watching the bar. Two of them because switching a single node between
          status and alert is the other half of the same trap: the politeness is
          read when the region is registered, so a node that changes it may
          announce with the old one or not at all. */}
      <p className="spl-visually-hidden" role="status" aria-live="polite">
        {message && message.tone !== 'error' ? message.text : ''}
      </p>
      <p className="spl-visually-hidden" role="alert" aria-live="assertive">
        {message && message.tone === 'error' ? message.text : ''}
      </p>

      {/* The visible box, unchanged in shape. Only the WORDS are hidden from a
          screen reader - the two regions above have already said them, and the
          same sentence twice is its own small defect. The button is not inside
          anything hidden, because a focusable control in an aria-hidden subtree
          is a worse problem than the one being solved. */}
      {message && (
        <p className={message.tone === 'error' ? 'spl-alert spl-alert-error' : 'spl-alert'}>
          {/* Said in a word as well as in a colour: the two alerts differ only
              by the colour of a three-pixel border, which is no difference at
              all to a colour-blind reader. */}
          <span className="spl-alert-label" aria-hidden="true">{message.tone === 'error' ? 'Problem:' : 'Note:'}</span>
          <span className="spl-alert-text" aria-hidden="true">{message.text}</span>
          <button type="button" className="spl-alert-close" onClick={() => setMessage(null)} aria-label="Dismiss this message">
            ×
          </button>
        </p>
      )}

      {/* Things overlapping is said in words, not only as a red outline on a
          canvas. It matters more than an ordinary warning: anything left
          standing in a column is staged by the server when the room is saved,
          so a shopper who cannot see the outline loses furniture out of the
          room with no idea why. */}
      {/* Announced from a region of its own, permanently mounted for the same
          reason as the two above: one that arrives with its text is one most
          screen readers never read out. */}
      <p className="spl-visually-hidden" role="status" aria-live="polite">
        {clashCount > 0 && planMode === 'furnish' ? clashSentence : ''}
      </p>
      {clashingIds.length > 0 && planMode === 'furnish' && (
        <p className="spl-alert">
          <span className="spl-alert-label" aria-hidden="true">Note:</span>
          <span className="spl-alert-text" aria-hidden="true">{clashSentence}</span>
          <button
            type="button"
            className="spl-btn spl-btn-sm"
            onClick={() => { dispatch({ type: 'select', ids: clashingIds }); setTab('selected') }}
          >
            Show me what is overlapping
          </button>
        </p>
      )}

      {stage === 'orbit' && planMode === 'furnish' && (
        <ViewsStrip
          views={views}
          busy={viewsBusy}
          signedIn={props.signedIn}
          onKeep={() => void saveCurrentView()}
          onGo={goToView}
          onRename={(id, name) => void renameView(id, name)}
          onRepoint={(id) => void updateViewCamera(id)}
          onDelete={(id) => void deleteView(id)}
        />
      )}

      {/* On paper the heading comes before the plan and the item list after it,
          which is why this is two blocks rather than one. */}
      <div className="spl-print-only spl-print-head">
        <h2>{props.heading}</h2>
        <span>
          {areaM2.toFixed(1)} m² · {placed.length} {placed.length === 1 ? 'item' : 'items'} · {state.geometry.vertices.length} walls
        </span>
      </div>

      <div className={planMode !== 'furnish' ? 'spl-body spl-body-editing' : 'spl-body'}>
        <div className="spl-stage" id="spl-view-stage" role="tabpanel" aria-labelledby={`spl-view-tab-${stage}`}>
          {stage === 'plan' ? (
            <Plan2d
              geometry={state.geometry}
              items={state.items}
              selection={state.selection}
              labels={labels}
              clashes={clashes}
              walkwayClearanceMm={props.guidance.enabled ? props.guidance.walkwayClearanceMm : 0}
              mode={planMode}
              onSelect={(ids) => {
                dispatch({ type: 'select', ids })
                if (ids.length > 0) setTab('selected')
              }}
              onDragItems={(ids, dx, dy, snap) => dispatch({ type: 'move-items', ids, dx, dy, snap })}
              onRotateItems={(ids, deltaDeg, snap) => dispatch({ type: 'rotate-items', ids, deltaDeg, snap })}
              onDragStart={commit}
              onDragEnd={() => setDirty(true)}
              onWallClick={(wallIndex, currentLengthMm) => setWallEdit({ index: wallIndex, lengthMm: currentLengthMm })}
              onShape={applyShape}
              onDrawDone={finishDrawing}
              onDrawCancel={cancelDrawing}
              openingSelection={openingSelection}
              openingKind={openingKind}
              onSelectOpening={setOpeningSelection}
              onAddOpening={(wallIndex, offsetMm) => {
                const id = nextId()
                dispatch({ type: 'add-opening', id, kind: openingKind, wallIndex, offsetMm })
                setOpeningSelection(id)
                setDirty(true)
              }}
              onMoveOpening={(id, offsetMm) => dispatch({ type: 'set-opening', id, patch: { offsetMm } })}
              obstructionSelection={obstructionSelection}
              onSelectObstruction={setObstructionSelection}
              onAddObstruction={(x, y) => {
                const id = nextId()
                // Full height by default, because the thing people draw is a
                // structural column - and a column you can see over is a plinth.
                dispatch({ type: 'add-obstruction', id, x, y, widthMm: 300, depthMm: 300, heightMm: state.geometry.ceilingMm, label: 'Column' })
                setObstructionSelection(id)
                setDirty(true)
              }}
              onMoveObstruction={(id, dx, dy, settle) => dispatch({ type: 'move-obstruction', id, dx, dy, settle })}
              registerCapture={(capture) => { capturePlan.current = capture }}
            />
          ) : (
            <View3d
              description={description}
              models={models}
              options={prepareOptions}
              view="orbit"
              perspective={perspective}
              units={state.geometry.units}
              restore={restore}
              registerCapture={(capture) => { captureView.current = capture }}
              registerCameraProbe={(probe) => { cameraProbe.current = probe }}
              onBusyChange={(busy) => { viewBusy.current = busy }}
              onMeasuredSizes={adoptMeasuredSizes}
            />
          )}

          {/* Undo and redo, on the room itself - but only where the toolbar
              cannot carry them. On a phone the pair lives behind "More", and
              there is no Ctrl+Z on a touchscreen: the two of them together
              made a mis-drag effectively permanent for anybody on a phone.
              Hidden from every wider screen by the stylesheet, and stood down
              while the room itself is being drawn or reshaped - those modes
              own the stage and have their own ways back. */}
          {planMode === 'furnish' && (
            <div className="spl-stage-undo">
              <button
                type="button"
                className="spl-btn spl-btn-icon"
                aria-label="Undo"
                title="Undo"
                disabled={history.past.length === 0}
                onClick={() => applyStep(undo(history, state))}
              >
                ↺
              </button>
              <button
                type="button"
                className="spl-btn spl-btn-icon"
                aria-label="Redo"
                title="Redo"
                disabled={history.future.length === 0}
                onClick={() => applyStep(redo(history, state))}
              >
                ↻
              </button>
            </div>
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

          {exporting && (
            <ExportDialog
              busy={exportBusy}
              step={exportStep}
              signedIn={props.signedIn}
              views={views}
              onCancel={() => setExporting(false)}
              onExport={(options) => void exportPdf(options)}
            />
          )}

          {photos && (
            <PhotoDialog
              signedIn={props.signedIn}
              planId={savedPlanId}
              planLabel={`${roomName} - ${planName}`}
              savePlan={() => savePlan({ quiet: true })}
              views={views}
              currentCamera={photoCamera}
              onClose={() => setPhotos(false)}
            />
          )}

          {startAgain && (
            <StartAgainDialog
              itemCount={state.items.length}
              onCancel={() => setStartAgain(false)}
              onConfirm={(clearItems) => {
                commit()
                if (clearItems) dispatch({ type: 'delete-items', ids: state.items.map((item) => item.id) })
                setStartAgain(false)
                setPlanMode('furnish')
                setStage('plan')
                setStarted(false)
              }}
            />
          )}

          {roomEdit && (
            <RoomDialog
              geometry={state.geometry}
              onCancel={() => setRoomEdit(false)}
              onCeiling={(mm) => {
                commit()
                dispatch({ type: 'set-geometry', geometry: { ...state.geometry, ceilingMm: mm } })
                setRoomEdit(false)
              }}
              onEditShape={() => {
                commit()
                setRoomEdit(false)
                setStage('plan')
                setPlanMode('shape')
              }}
              onEditOpenings={() => {
                setRoomEdit(false)
                setStage('plan')
                setOpeningSelection(null)
                setPlanMode('openings')
              }}
              onEditObstructions={() => {
                setRoomEdit(false)
                setStage('plan')
                setObstructionSelection(null)
                setPlanMode('obstructions')
              }}
              onDraw={startDrawing}
            />
          )}
        </div>

        <aside className="spl-side">
          <div className="spl-tabs" role="tablist" aria-label="Panels">
            {(tray.length > 0 ? (['catalogue', 'tray', 'selected', 'items'] as Tab[]) : (['catalogue', 'selected', 'items'] as Tab[])).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                id={`spl-tab-${option}`}
                aria-controls={`spl-panel-${option}`}
                className="spl-tab"
                aria-selected={activeTab === option}
                onClick={() => setTab(option)}
              >
                {TAB_LABELS[option]}
                {option === 'selected' && state.selection.length > 0 ? ` (${state.selection.length})` : ''}
                {option === 'tray' ? ` (${tray.length})` : ''}
                {option === 'items' && placed.length > 0 ? ` (${placed.length})` : ''}
              </button>
            ))}
          </div>

          <div className="spl-side-scroll">
            {/* The catalogue stays MOUNTED and is merely hidden behind the
                other tabs: its search, category, page and filter are the
                shopper's place in a big catalogue, and unmounting the panel on
                every tab switch threw all four away - place a desk, nudge it,
                and you were back on page one, unfiltered. */}
            <div
              id="spl-panel-catalogue"
              role="tabpanel"
              aria-labelledby="spl-tab-catalogue"
              hidden={activeTab !== 'catalogue'}
              className="spl-stack"
            >
              <CataloguePanel onPlace={place} onPlaceProduct={placeProduct} placedCounts={placedCounts} />
            </div>

            {/* All three stay mounted and hidden, like the catalogue above.
                Rendering them only while active left every tab's aria-controls
                pointing at an element that did not exist, which is a broken
                relationship rather than a missing nicety - and the stylesheet
                already makes [hidden] mean hidden. */}
            <div className="spl-stack">
              <div id="spl-panel-tray" role="tabpanel" aria-labelledby="spl-tab-tray" className="spl-stack" hidden={activeTab !== 'tray'}>
                <TrayPanel
                  items={tray}
                  products={products}
                  note={trayNote}
                  onPlace={placeFromTray}
                  onPlaceAll={placeAllFromTray}
                  onRemove={removeFromTray}
                  onRefresh={() => void stageFromCart('refresh')}
                  onClearAll={() => { commit(); dispatch({ type: 'clear-staged' }); setTrayNote('') }}
                />
              </div>

              <div id="spl-panel-selected" role="tabpanel" aria-labelledby="spl-tab-selected" className="spl-stack" hidden={activeTab !== 'selected'}>
                <SelectedPanel
                  state={state}
                  products={products}
                  onPatch={(id, patch) => { commit(); dispatch({ type: 'set-item', id, patch }) }}
                  onRotate={(ids, deltaDeg) => { commit(); dispatch({ type: 'rotate-items', ids, deltaDeg, snap: false }) }}
                  onDelete={(ids) => { commit(); dispatch({ type: 'delete-items', ids }) }}
                  onDuplicate={(ids) => { commit(); dispatch({ type: 'duplicate-items', ids, offsetMm: 200, newIds: ids.map(() => nextId()) }) }}
                  onArray={(id, count, spacing, alongYaw) => {
                    commit()
                    dispatch({ type: 'array-item', id, count, spacingMm: spacing, alongYaw, newIds: Array.from({ length: count }, () => nextId()) })
                  }}
                />
              </div>

              <div id="spl-panel-items" role="tabpanel" aria-labelledby="spl-tab-items" className="spl-stack" hidden={activeTab !== 'items'}>
                <ItemListPanel
                  items={placed}
                  products={products}
                  disclaimer={props.guidance.disclaimer}
                  priceDisclaimer={props.priceDisclaimer}
                  currencySymbol={props.currencySymbol}
                  selection={state.selection}
                  onSelect={(ids) => dispatch({ type: 'select', ids })}
                />
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* The printed sheet's second half: the document somebody hands over, so it
          carries the item list and the wording that says what the plan is and is
          not. */}
      <div className="spl-print-only">
        <ItemListPanel
          items={placed}
          products={products}
          disclaimer={props.guidance.disclaimer}
          priceDisclaimer={props.priceDisclaimer}
          currencySymbol={props.currencySymbol}
        />
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
  const dialogRef = useDialogFocus<HTMLFormElement>(props.onCancel)
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
        ref={dialogRef}
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

/**
 * What goes in the PDF.
 *
 * Three ticks, because the document is for three different audiences and nobody
 * wants all of it every time: the flat plan is what a fitter measures off, the
 * 3D view is what convinces whoever signs the order, and the quote page is what
 * goes to whoever pays. Defaulting to the plan and the item list and letting the
 * shopper add the rest is the honest arrangement - the picture is the slow part,
 * and making everybody wait for one they did not want is how a button gets a
 * reputation.
 */
function ExportDialog(props: {
  busy: boolean
  /** Which phase the export is in, so the button says something that changes. */
  step: string
  signedIn: boolean
  /** Saved viewpoints for this room - any of them can go in as its own picture. */
  views: SplRoomView[]
  onCancel: () => void
  onExport: (options: { includePlanView: boolean; include3dView: boolean; includeQuote: boolean; viewIds: string[] }) => void
}) {
  const ids = useId()
  const dialogRef = useDialogFocus<HTMLDivElement>(props.busy ? undefined : props.onCancel)
  const [includePlanView, setIncludePlanView] = useState(true)
  const [include3dView, setInclude3dView] = useState(false)
  const [includeQuote, setIncludeQuote] = useState(false)
  const [viewIds, setViewIds] = useState<string[]>([])

  const toggleView = (viewId: string, on: boolean) => {
    setViewIds((current) => (on ? [...current, viewId] : current.filter((id) => id !== viewId)))
  }

  return (
    <div className="spl-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !props.busy) props.onCancel() }}>
      <div ref={dialogRef} className="spl-dialog" role="dialog" aria-modal="true" aria-label="Export as a PDF">
        <h2>Save this as a PDF</h2>
        <p className="spl-note">The room&apos;s measurements and everything in it, priced, are always included.</p>

        <label className="spl-check" htmlFor={`${ids}-plan`}>
          <input id={`${ids}-plan`} type="checkbox" checked={includePlanView} onChange={(event) => setIncludePlanView(event.target.checked)} />
          <span>The flat plan, as you have it on screen</span>
        </label>
        <label className="spl-check" htmlFor={`${ids}-3d`}>
          <input id={`${ids}-3d`} type="checkbox" checked={include3dView} onChange={(event) => setInclude3dView(event.target.checked)} />
          <span>The 3D view - takes a few seconds longer</span>
        </label>

        {props.views.length > 0 && (
          <>
            <p className="spl-note">Your saved views, each as its own picture:</p>
            {props.views.map((view) => (
              <label key={view.id} className="spl-check" htmlFor={`${ids}-view-${view.id}`}>
                <input
                  id={`${ids}-view-${view.id}`}
                  type="checkbox"
                  checked={viewIds.includes(view.id)}
                  onChange={(event) => toggleView(view.id, event.target.checked)}
                />
                <span>{view.name}</span>
              </label>
            ))}
          </>
        )}

        <label className="spl-check" htmlFor={`${ids}-quote`}>
          <input id={`${ids}-quote`} type="checkbox" checked={includeQuote} onChange={(event) => setIncludeQuote(event.target.checked)} />
          <span>A quote page, on our usual quote wording and terms</span>
        </label>

        {!props.signedIn && (
          <p className="spl-note">You will be asked to sign in first - the PDF is made from your saved plan.</p>
        )}

        <div className="spl-buttons">
          {/* Enabled throughout. The work carries on in the background either
              way - the pictures are already being taken and the save has its own
              guard - but a shopper who has changed their mind, or whose export
              is stuck behind a cold-starting browser on the server, is not held
              in a modal until it finishes. */}
          <button type="button" className="spl-btn" onClick={props.onCancel}>{props.busy ? 'Close' : 'Cancel'}</button>
          <button
            type="button"
            className="spl-btn spl-btn-primary"
            disabled={props.busy}
            autoFocus
            onClick={() => props.onExport({ includePlanView, include3dView, includeQuote, viewIds })}
          >
            {props.busy ? props.step || 'Making it…' : 'Make the PDF'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One picture, as the member's own render endpoint describes it. */
type PhotoJob = {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'
  url: string
  error: string
  createdAt: string
  /** The layout has been changed since this was taken. */
  stale: boolean
  /** When the layout it shows was saved. Null on jobs from before that was recorded. */
  depicts: string | null
}

async function fetchPhotos(planId: string): Promise<PhotoJob[]> {
  const response = await fetch(`/api/m/space-planner-for-shop/member/plans/${planId}/render`)
  if (!response.ok) throw new Error('could not list the pictures')
  const data = (await response.json()) as { jobs: PhotoJob[] }
  return data.jobs
}

const PHOTO_POLL_MS = 4_000
/** How long a picture may take before the dialog admits it is taking a while. */
const PHOTO_SLOW_MS = 4 * 60_000

/**
 * A photograph of the room.
 *
 * Asked for and then waited for, rather than made here: the room is built again
 * properly on a machine of its own - full-size models, real shadows, no budget
 * for a phone to worry about - and that takes minutes rather than the moment a
 * button press is allowed to take. So this posts, polls, and is perfectly happy
 * to be closed in between. The picture carries on without anybody watching it.
 *
 * Every ask saves the plan on the way, not just the first: the picture is built
 * server-side from the SAVED layout, so a desk moved after this dialog opened
 * would otherwise be photographed where it used to be.
 */
function PhotoDialog(props: {
  signedIn: boolean
  planId: string | null
  planLabel: string
  savePlan: () => Promise<string | null>
  /** Saved viewpoints for this room, any of which can be photographed. */
  views: SplRoomView[]
  /** Where they were standing when they opened this. Null if the flat plan was showing. */
  currentCamera: SavedCamera | null
  onClose: () => void
}) {
  const [planId, setPlanId] = useState<string | null>(props.planId)
  const [jobs, setJobs] = useState<PhotoJob[]>([])
  const [chosen, setChosen] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(props.planId))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  /**
   * Whether the one being drawn has been a while.
   *
   * Set from the poll below rather than from a timer of its own, and worked out
   * from the job's own start: the poll is already the clock, and a separate
   * timer would only have to be reset every time the list came back anyway.
   */
  const [slow, setSlow] = useState(false)
  const [tick, setTick] = useState(0)
  /**
   * Which angle to photograph from: 'here', 'wall', or a saved view's id.
   *
   * Defaults to where they are standing when there is such a place, because the
   * complaint that produced this picker was a photograph coming back from
   * somewhere the shopper had never pointed the camera. 'wall' is the old canned
   * standpoint, kept as a choice rather than deleted - it is genuinely the better
   * answer in a small room, where standing where you were standing means standing
   * inside a desk.
   */
  const [from, setFrom] = useState<string>(props.currentCamera ? 'here' : 'wall')
  const dialogRef = useDialogFocus<HTMLDivElement>(busy ? undefined : props.onClose)

  const live = jobs.find((job) => job.status === 'QUEUED' || job.status === 'RUNNING') ?? null
  const liveId = live?.id ?? ''
  const done = jobs.filter((job) => job.status === 'DONE' && job.url)
  const showing = done.find((job) => job.id === chosen) ?? done[0] ?? null
  const newest = jobs[0] ?? null
  const failure = newest && newest.status === 'FAILED' ? newest.error : ''

  // What is already there, on open. A plan that has never been saved has no
  // pictures by definition, so it is not saved merely for opening this.
  const openedWith = props.planId
  useEffect(() => {
    if (!openedWith) return
    let cancelled = false
    void (async () => {
      try {
        const list = await fetchPhotos(openedWith)
        if (!cancelled) setJobs(list)
      } catch {
        if (!cancelled) setProblem('We could not fetch your pictures just now.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [openedWith])

  // Polling, and only while something is actually being drawn. `tick` is what
  // re-arms it: a poll that failed on the network is not a failed picture, and
  // keying off the job list alone would stop asking the moment one request did.
  useEffect(() => {
    if (!planId || !liveId) return
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const list = await fetchPhotos(planId)
          if (cancelled) return
          setJobs(list)
          const going = list.find((job) => job.status === 'QUEUED' || job.status === 'RUNNING')
          setSlow(going ? Date.now() - new Date(going.createdAt).getTime() > PHOTO_SLOW_MS : false)
        } catch {
          // Left to the next go round rather than shown: one dropped poll is not
          // news, and the picture is unaffected either way.
        } finally {
          if (!cancelled) setTick((count) => count + 1)
        }
      })()
    }, PHOTO_POLL_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [planId, liveId, tick])

  const make = async () => {
    setBusy(true)
    setProblem('')
    try {
      // Signed out, this is the point at which they are sent to sign in - the
      // picture is made from a saved plan, and there is nothing to save into.
      const id = await props.savePlan()
      if (!id) return
      setPlanId(id)
      // No camera means the canned standpoint, which is exactly what the route
      // does with an empty body - so 'wall' sends nothing rather than sending a
      // second way of saying the same thing.
      const camera = from === 'here' ? props.currentCamera : (props.views.find((view) => view.id === from)?.camera ?? null)
      const response = await fetch(`/api/m/space-planner-for-shop/member/plans/${id}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(camera ? { camera } : {}),
      })
      const data = (await response.json().catch(() => null)) as { error?: string } | null
      if (!response.ok) throw new Error(data?.error ?? 'We could not start that picture just now.')
      setChosen(null)
      setSlow(false)
      setJobs(await fetchPhotos(id))
      setLoading(false)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'We could not start that picture just now.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="spl-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) props.onClose() }}>
      <div ref={dialogRef} className="spl-dialog spl-dialog-wide" role="dialog" aria-modal="true" aria-label="A photograph of your room">
        <h2>A photograph of your room</h2>
        <p className="spl-note">
          We build the room again properly and take a picture of it, which takes a few minutes. You do not have to sit and
          watch - close this and it will be waiting for you.
        </p>

        {loading ? (
          <div className="spl-photo-empty"><span className="spl-note">Looking for your pictures…</span></div>
        ) : showing ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- the picture arrives as a plain media url from the render worker, and next/image would want a loader and a known size for a one-off nobody scrolls past */}
            <img className="spl-photo" src={showing.url} alt={`Your room, ${props.planLabel}`} />
            {showing.stale && (
              <p className="spl-note">
                This is the room as it was{showing.depicts ? ` on ${new Date(showing.depicts).toLocaleDateString()}` : ''}.
                You have moved things since, so make another one to catch up.
              </p>
            )}
          </>
        ) : (
          <div className="spl-photo-empty">
            <span className="spl-note">{live ? 'Your picture is being taken.' : 'No pictures of this layout yet.'}</span>
          </div>
        )}

        {live && (
          <p className="spl-note" role="status">
            {slow
              ? 'This one is taking longer than usual. Close this and come back to it - the picture carries on without you.'
              : 'Taking the picture…'}
          </p>
        )}

        {done.length > 1 && (
          <div className="spl-photo-strip">
            {done.map((job) => (
              <button
                key={job.id}
                type="button"
                className="spl-photo-thumb"
                aria-pressed={showing?.id === job.id}
                aria-label={`Picture from ${new Date(job.createdAt).toLocaleDateString()}`}
                onClick={() => setChosen(job.id)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- the same picture again at thumbnail size, from the same loader-less url */}
                <img src={job.url} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        )}

        <label className="spl-photo-from">
          <span>Taken from</span>
          <select className="spl-select" value={from} onChange={(event) => setFrom(event.target.value)} disabled={busy}>
            {props.currentCamera && <option value="here">Where I am looking now</option>}
            <option value="wall">Standing at the wall, looking down the room</option>
            {props.views.map((view) => (
              <option key={view.id} value={view.id}>{view.name}</option>
            ))}
          </select>
        </label>

        {failure && <p className="spl-alert spl-alert-error"><span className="spl-alert-text">{failure}</span></p>}
        {problem && <p className="spl-alert spl-alert-error"><span className="spl-alert-text">{problem}</span></p>}

        {!props.signedIn && <p className="spl-note">You will be asked to sign in first - the picture is made from your saved plan.</p>}

        <div className="spl-buttons">
          <button type="button" className="spl-btn" onClick={props.onClose} disabled={busy}>Close</button>
          {showing && (
            <>
              <a className="spl-btn spl-launch" href={showing.url} target="_blank" rel="noreferrer">Open full size</a>
              {/* A picture somebody waited minutes for is one they want to keep.
                  Without the download attribute, saving it on a phone was a
                  long-press and a guess. */}
              <a
                className="spl-btn spl-launch"
                href={showing.url}
                download={`${props.planLabel}.webp`.replace(/[^A-Za-z0-9 ._-]+/g, '')}
              >
                Save the picture
              </a>
            </>
          )}
          <button
            type="button"
            className="spl-btn spl-btn-primary"
            onClick={() => void make()}
            disabled={busy || Boolean(live)}
          >
            {busy ? 'Asking…' : live ? 'One on the way' : done.length > 0 ? 'Make another' : 'Make a photo'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The saved viewpoints, along the top of the 3D view.
 *
 * A strip rather than a dialog, because choosing an angle is a thing you do
 * repeatedly while looking at the room - flick to the doorway, flick to the
 * window, decide - and a dialog between each flick turns comparing three views
 * into nine interruptions. It is the same argument the openings toolbar makes.
 *
 * Renaming is in place on the chip. There is no separate rename dialog because
 * there is nothing else to say about a view: it has a name and a camera, and the
 * camera is changed by standing somewhere else and pressing the button.
 */
function ViewsStrip(props: {
  views: SplRoomView[]
  busy: boolean
  signedIn: boolean
  onKeep: () => void
  onGo: (view: SplRoomView) => void
  onRename: (id: string, name: string) => void
  onRepoint: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)

  // A menu opened by a tap closes on the next tap anywhere else, and on Escape.
  // Without it the only way out was pressing the same ⋯ again - so a menu opened
  // by accident sat over the strip until it was found and dismissed.
  useEffect(() => {
    if (!menu) return
    const away = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.spl-view-chip')) return
      setMenu(null)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setMenu(null)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key, true)
    }
  }, [menu])

  return (
    <div className="spl-views">
      <span className="spl-views-label">Views</span>

      {props.views.length === 0 && (
        <span className="spl-note">
          {props.signedIn
            ? 'Find an angle you like and keep it - you can photograph any layout in this space from the same spot.'
            : 'Sign in to keep the angles you like and photograph every layout from the same spot.'}
        </span>
      )}

      {props.views.map((view) => (
        <span key={view.id} className="spl-view-chip">
          {editing === view.id ? (
            <input
              className="spl-view-name"
              defaultValue={view.name}
              autoFocus
              aria-label="View name"
              onBlur={(event) => {
                const name = event.target.value.trim()
                if (name && name !== view.name) props.onRename(view.id, name)
                setEditing(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <button type="button" className="spl-view-go" onClick={() => props.onGo(view)}>
              {view.name}
            </button>
          )}
          <button
            type="button"
            className="spl-view-more"
            aria-label={`More for ${view.name}`}
            aria-expanded={menu === view.id}
            onClick={() => setMenu((open) => (open === view.id ? null : view.id))}
          >
            ⋯
          </button>
          {menu === view.id && (
            <span className="spl-view-menu">
              <button type="button" onClick={() => { setEditing(view.id); setMenu(null) }}>Rename</button>
              <button type="button" onClick={() => { props.onRepoint(view.id); setMenu(null) }}>Move here</button>
              <button type="button" className="spl-view-danger" onClick={() => { props.onDelete(view.id); setMenu(null) }}>
                Delete
              </button>
            </span>
          )}
        </span>
      ))}

      <button type="button" className="spl-btn spl-btn-sm" onClick={props.onKeep} disabled={props.busy}>
        {props.busy ? 'Keeping…' : 'Keep this view'}
      </button>
    </div>
  )
}

/**
 * The doors-and-windows toolbar.
 *
 * In the top bar rather than in a dialog, because putting a door in is a
 * sequence - tap a wall, nudge it along, get the width right, then the next one -
 * and a dialog between each step turns four doors into twelve interruptions.
 *
 * The measurements are the ordinary ones on a set of plans: how wide, how tall,
 * and how far off the floor. A door's sill is nought and stays out of the way
 * until somebody puts a window in.
 */
function OpeningsBar(props: {
  geometry: RoomGeometry
  kind: OpeningKind
  onKind: (kind: OpeningKind) => void
  selection: string | null
  onPatch: (patch: { widthMm?: number; heightMm?: number; sillMm?: number; kind?: OpeningKind }) => void
  onRemove: () => void
  onDone: () => void
}) {
  const selected = props.geometry.openings.find((opening) => opening.id === props.selection) ?? null
  const units = props.geometry.units

  return (
    <div className="spl-bar-actions">
      {selected ? (
        <>
          <select
            className="spl-select spl-select-sm"
            aria-label="What this is"
            value={selected.kind}
            onChange={(event) => props.onPatch({ kind: event.target.value as OpeningKind })}
          >
            <option value="door">Door</option>
            <option value="window">Window</option>
            <option value="opening">Opening</option>
          </select>
          <LengthField label="Wide" mm={selected.widthMm} units={units} onChange={(mm) => props.onPatch({ widthMm: mm })} />
          <LengthField label="Tall" mm={selected.heightMm} units={units} onChange={(mm) => props.onPatch({ heightMm: mm })} />
          {selected.kind !== 'door' && (
            <LengthField label="Off the floor" mm={selected.sillMm} units={units} onChange={(mm) => props.onPatch({ sillMm: mm })} />
          )}
          <button type="button" className="spl-btn spl-btn-danger" onClick={props.onRemove}>Remove</button>
        </>
      ) : (
        <>
          <span className="spl-note">Adding:</span>
          <select
            className="spl-select spl-select-sm"
            aria-label="What a tap on a wall adds"
            value={props.kind}
            onChange={(event) => props.onKind(event.target.value as OpeningKind)}
          >
            <option value="door">Doors</option>
            <option value="window">Windows</option>
            <option value="opening">Openings</option>
          </select>
        </>
      )}
      <button type="button" className="spl-btn spl-btn-primary" onClick={props.onDone}>Done</button>
    </div>
  )
}

/**
 * The columns-and-pillars toolbar, the same shape as the doors one and for the
 * same reason: putting a column in is tap, nudge, size, next - and a dialog
 * between each step would turn three columns into nine interruptions.
 *
 * The size fields read the outline's bounding box, which for everything this
 * bar creates IS the outline - the planner only draws rectangular columns, and
 * anything fancier arrived in the data rather than through this bar.
 */
function ObstructionsBar(props: {
  geometry: RoomGeometry
  selection: string | null
  onPatch: (patch: { label?: string; widthMm?: number; depthMm?: number; heightMm?: number }) => void
  onRemove: () => void
  onDone: () => void
}) {
  const selected = props.geometry.obstructions.find((obstruction) => obstruction.id === props.selection) ?? null
  const units = props.geometry.units
  const box = selected ? boundingBox(selected.vertices) : null

  return (
    <div className="spl-bar-actions">
      {selected && box ? (
        <>
          <input
            key={selected.id}
            className="spl-input spl-input-sm"
            aria-label="What to call it"
            defaultValue={selected.label || 'Column'}
            onBlur={(event) => {
              const label = event.target.value.trim()
              if (label && label !== selected.label) props.onPatch({ label })
            }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
          <LengthField label="Wide" mm={Math.round(box.maxX - box.minX)} units={units} onChange={(mm) => props.onPatch({ widthMm: mm })} />
          <LengthField label="Deep" mm={Math.round(box.maxY - box.minY)} units={units} onChange={(mm) => props.onPatch({ depthMm: mm })} />
          <LengthField label="Tall" mm={selected.heightMm} units={units} onChange={(mm) => props.onPatch({ heightMm: mm })} />
          <button type="button" className="spl-btn spl-btn-danger" onClick={props.onRemove}>Remove</button>
        </>
      ) : (
        <span className="spl-note">Tap the floor where the column stands.</span>
      )}
      <button type="button" className="spl-btn spl-btn-primary" onClick={props.onDone}>Done</button>
    </div>
  )
}

/**
 * A length in whatever units the room is in, typed rather than spun.
 *
 * Held as text while it is being edited, so a half-typed "1" is not read as a
 * one-millimetre window and clamped to the minimum before the second digit
 * arrives.
 */
function LengthField(props: { label: string; mm: number; units: RoomGeometry['units']; onChange: (mm: number) => void }) {
  const id = useId()
  const [text, setText] = useState(() => formatLength(props.mm, props.units))
  const [editing, setEditing] = useState(false)

  return (
    <div className="spl-field spl-field-inline">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        className="spl-input spl-input-sm"
        value={editing ? text : formatLength(props.mm, props.units)}
        onFocus={() => { setText(formatLength(props.mm, props.units)); setEditing(true) }}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          setEditing(false)
          const mm = parseLengthMm(text, props.units === 'imperial' ? 'in' : 'mm')
          if (mm !== null && mm > 0) props.onChange(mm)
        }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      />
    </div>
  )
}

/**
 * Starting again.
 *
 * Confirmed, and the confirmation says what survives: by default the room goes
 * and the furniture does not. Somebody who has spent twenty minutes choosing
 * twelve desks needs to know that before they press it, not after - and somebody
 * starting a genuinely different job needs the one tick that clears the lot,
 * rather than removing twelve things one at a time.
 */
function StartAgainDialog(props: { itemCount: number; onCancel: () => void; onConfirm: (clearItems: boolean) => void }) {
  const fieldId = useId()
  const dialogRef = useDialogFocus<HTMLDivElement>(props.onCancel)
  const [clearItems, setClearItems] = useState(false)

  return (
    <div className="spl-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) props.onCancel() }}>
      <div ref={dialogRef} className="spl-dialog" role="dialog" aria-modal="true" aria-label="Start again">
        <h2>Start again?</h2>
        <p className="spl-note">
          {props.itemCount === 0
            ? 'You will go back to picking a shape for the room.'
            : clearItems
              ? `You will go back to picking a shape, and ${props.itemCount === 1 ? 'the one thing' : `all ${props.itemCount} things`} you have chosen will be taken out.`
              : `You will go back to picking a shape. ${props.itemCount === 1 ? 'The one thing' : `All ${props.itemCount} things`} you have chosen ${props.itemCount === 1 ? 'is' : 'are'} kept - anything that no longer fits the new shape waits under "Cart" for you to drop back in.`}
        </p>
        {props.itemCount > 0 && (
          <label className="spl-check" htmlFor={fieldId}>
            <input id={fieldId} type="checkbox" checked={clearItems} onChange={(event) => setClearItems(event.target.checked)} />
            <span>Take everything out of the room as well</span>
          </label>
        )}
        <div className="spl-buttons">
          <button type="button" className="spl-btn" onClick={props.onCancel}>Keep this room</button>
          <button type="button" className="spl-btn spl-btn-danger" autoFocus onClick={() => props.onConfirm(clearItems)}>Start again</button>
        </div>
      </div>
    </div>
  )
}

/** The room itself, after the first run: ceiling height, and the way back out. */
function RoomDialog(props: {
  geometry: RoomGeometry
  onCancel: () => void
  onCeiling: (mm: number) => void
  onEditShape: () => void
  onEditOpenings: () => void
  onEditObstructions: () => void
  onDraw: () => void
}) {
  const fieldId = useId()
  const dialogRef = useDialogFocus<HTMLFormElement>(props.onCancel)
  const [value, setValue] = useState(() => formatLength(props.geometry.ceilingMm, props.geometry.units))
  const [error, setError] = useState('')

  return (
    <div className="spl-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) props.onCancel() }}>
      <form
        ref={dialogRef}
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
        <p className="spl-note">
          {props.geometry.vertices.length} walls. Click any one of them on the flat plan to type its length.
        </p>
        <div className="spl-buttons">
          <button type="button" className="spl-btn" onClick={props.onEditShape}>Change the shape</button>
          <button type="button" className="spl-btn" onClick={props.onEditOpenings}>
            Doors &amp; windows{props.geometry.openings.length > 0 ? ` (${props.geometry.openings.length})` : ''}
          </button>
          <button type="button" className="spl-btn" onClick={props.onEditObstructions}>
            Columns &amp; pillars{props.geometry.obstructions.length > 0 ? ` (${props.geometry.obstructions.length})` : ''}
          </button>
          <button type="button" className="spl-btn" onClick={props.onDraw}>Draw a new one</button>
        </div>
        <p className="spl-note">
          Changing the shape lets you drag the corners about and add new ones, so an L-shape, a bay or a return is a
          couple of taps rather than a compromise. Doors and windows go on the walls themselves - worth putting in
          before you arrange anything, since a desk in front of a doorway is the whole reason for drawing the room.
          Columns and pillars are the things standing in the middle of the floor: draw them in and the planner knows
          nothing can stand where they do.
        </p>
        <div className="spl-field">
          <label htmlFor={fieldId}>Ceiling height</label>
          <input id={fieldId} className="spl-input" value={value} autoFocus onChange={(event) => { setValue(event.target.value); setError('') }} />
        </div>
        {error && <p className="spl-alert spl-alert-error"><span className="spl-alert-text">{error}</span></p>}
        <div className="spl-buttons">
          <button type="button" className="spl-btn" onClick={props.onCancel}>Close</button>
          <button type="submit" className="spl-btn spl-btn-primary">Save the height</button>
        </div>
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
function FirstRun(props: {
  heading: string
  intro: string
  /** Arrived from the basket - say so, or the basket appears to have vanished. */
  fromCart?: boolean
  /** Rooms already saved. Empty for a visitor with none, and for one signed out. */
  savedRooms: SavedRoomLink[]
  signedIn: boolean
  signInHref: string
  onReady: (geometry: RoomGeometry) => void
  onDraw: () => void
}) {
  const ids = useId()
  const [mode, setMode] = useState<'choose' | 'type'>('choose')
  const [width, setWidth] = useState('6.2m')
  const [depth, setDepth] = useState('4.1m')
  const [ceiling, setCeiling] = useState('2.4m')
  const [error, setError] = useState('')

  const shape = (vertices: RoomGeometry['vertices']) => {
    props.onReady({ ...defaultRoomGeometry(), vertices })
  }

  const preset = (widthMm: number, depthMm: number) => {
    shape([
      { x: 0, y: 0 },
      { x: widthMm, y: 0 },
      { x: widthMm, y: depthMm },
      { x: 0, y: depthMm },
    ])
  }

  const submitTyped = () => {
    const w = parseLengthMm(width)
    const d = parseLengthMm(depth)
    const c = parseLengthMm(ceiling)
    if (!w || !d || !c || w < 500 || d < 500) {
      setError('One of those did not read as a length. Try something like 4.2m or 4200.')
      return
    }
    if (w > 100_000 || d > 100_000) {
      // A typo, not a warehouse: 4200m reads as a length and draws a room the
      // grid can barely address. The geometry validators catch this on every
      // other path in; this is the one they miss.
      setError('That is over 100 m on a side. If the space really is that big, plan it in sections.')
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
  }

  if (mode === 'type') {
    return (
      // A real form, so Enter in any of the three fields does what Enter does
      // everywhere else. It was three loose inputs and a button: somebody typing
      // their office with a tape measure in the other hand had to stop, find the
      // mouse, and click - which is the exact moment this screen loses people.
      <form
        className="spl-first-run"
        onSubmit={(event) => { event.preventDefault(); submitTyped() }}
      >
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
          <button type="submit" className="spl-btn spl-btn-primary">
            That is my room
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="spl-first-run">
      <h1 className="spl-title">{props.heading}</h1>
      <p className="spl-note">{props.intro}</p>
      {props.fromCart && (
        <p className="spl-alert">Your basket is coming along - once the room exists, everything in it will be waiting under the Cart tab.</p>
      )}

      {/* Rooms already saved, first and by name.
          A visitor with none never sees any of this, so it costs the main path
          nothing - and somebody who measured their office last week should not
          have to go via their account to get back into it.

          These link to the SAME route with different search parameters, which is
          why the page keys the planner on which room it is showing: without that
          a soft navigation would hand this component a new room while it still
          held the last one's name and save id. */}
      {props.savedRooms.length > 0 && (
        <>
          <p className="spl-note">Pick up where you left off:</p>
          <div className="spl-saved">
            {props.savedRooms.map((room) => (
              <Link
                key={room.id}
                prefetch={false}
                className="spl-saved-row"
                href={room.planId ? `/space-planner?plan=${room.planId}` : `/space-planner?room=${room.id}`}
              >
                <span className="spl-saved-name">{room.name}</span>
                <span className="spl-saved-meta">
                  {room.areaM2.toFixed(1)} m² ·{' '}
                  {room.planCount === 0
                    ? 'nothing in it yet'
                    : `${room.planCount} ${room.planCount === 1 ? 'layout' : 'layouts'}`}{' '}
                  · open →
                </span>
              </Link>
            ))}
            <Link prefetch={false} className="spl-saved-more" href="/space-planner/spaces">
              All your spaces, and every layout in them →
            </Link>
          </div>
          <p className="spl-note">Or measure a new room:</p>
        </>
      )}

      {/* Two ways to say what the room is, and three shapes to start from and
          change. Split rather than five equal cards: "type it" and "draw it" are
          decisions about how you work, the presets are just a head start, and
          five identical boxes make the choice look harder than it is. */}
      <div className="spl-choices">
        <button type="button" className="spl-choice" onClick={() => setMode('type')}>
          <strong>I know the measurements</strong>
          <span className="spl-note">Type the width and depth. Quickest by a mile.</span>
        </button>
        <button type="button" className="spl-choice" onClick={props.onDraw}>
          <strong>Draw it myself</strong>
          <span className="spl-note">Tap out the corners, however many there are. Bays, returns, the lot.</span>
        </button>
      </div>
      <p className="spl-note">Or start from a shape and change it:</p>
      <div className="spl-buttons">
        <button type="button" className="spl-btn" onClick={() => preset(4000, 3000)}>Small office, 4 × 3 m</button>
        <button type="button" className="spl-btn" onClick={() => preset(8000, 6000)}>Open plan, 8 × 6 m</button>
        <button
          type="button"
          className="spl-btn"
          onClick={() =>
            // Six walls, the commonest awkward office shape there is.
            shape([
              { x: 0, y: 0 },
              { x: 7000, y: 0 },
              { x: 7000, y: 3000 },
              { x: 4000, y: 3000 },
              { x: 4000, y: 5500 },
              { x: 0, y: 5500 },
            ])
          }
        >
          L-shaped
        </button>
      </div>
      <p className="spl-note">
        Whichever you pick, you can click any wall afterwards and type its real length - the rest of the room follows -
        and <strong>Room</strong> lets you drag the corners about or add new ones.
      </p>
      {/* One quiet line rather than a block: a signed-out visitor is usually a
          new one, and the answer to "where have my rooms gone" should be here
          without the main path having to carry a sign-in prompt. */}
      {!props.signedIn && (
        <p className="spl-note">
          Saved a room here before?{' '}
          <Link prefetch={false} className="spl-saved-more" href={props.signInHref}>
            Sign in
          </Link>{' '}
          and it will be waiting for you.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Side panels
// ---------------------------------------------------------------------------

/**
 * The waiting list: things chosen but not yet in the room.
 *
 * Everything staged from the basket lands here, and so does anything a reshaped
 * room could no longer hold. It used to be a strip of bare text chips squeezed
 * above whichever panel was open, capped at about three rows - which for a
 * basket of a dozen things meant picking blind from a letterbox. A tab of full
 * cards says what each thing is, what it costs, and what tapping it does.
 */
function TrayPanel(props: {
  items: PlanItem[]
  products: Record<string, ProductInfo>
  /** Anything the basket held that could not come along, already worded. */
  note: string
  onPlace: (id: string) => void
  onPlaceAll: () => void
  onRemove: (id: string) => void
  onRefresh: () => void
  onClearAll: () => void
}) {
  if (props.items.length === 0) return <p className="spl-note">Nothing waiting to go in.</p>

  return (
    <div className="spl-stack">
      <p className="spl-note">Tap one to drop it into the room at a free spot.</p>
      {props.note && <p className="spl-alert">{props.note}</p>}
      {props.items.length > 1 && (
        <button type="button" className="spl-btn" onClick={props.onPlaceAll}>
          Put all {props.items.length} in the room
        </button>
      )}
      <div className="spl-buttons">
        <button type="button" className="spl-btn spl-btn-sm" onClick={props.onRefresh}>
          Refresh from basket
        </button>
        {/* One press rather than twenty. A basket of twenty lines at a dozen
            apiece fills this list with more than a layout may hold, and taking
            them off one at a time is not an answer to that. */}
        {props.items.length > 1 && (
          <button type="button" className="spl-btn spl-btn-sm" onClick={props.onClearAll}>
            Clear the list
          </button>
        )}
      </div>
      <ul className="spl-list">
        {props.items.map((item) => {
          const info = props.products[item.productId]
          const name = info?.name ?? 'Item'
          return (
            <li key={item.id} className="spl-wait-row">
              <button type="button" className="spl-card" onClick={() => props.onPlace(item.id)}>
                {info?.image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the same catalogue thumbnail the browse panel shows, already sized by the media layer
                  <img src={info.image} alt="" loading="lazy" />
                ) : (
                  <span aria-hidden className="spl-card-noimage" />
                )}
                <span className="spl-card-body">
                  <span className="spl-card-name">{name}</span>
                  <span className="spl-card-meta">
                    {info?.priceFormatted ? `${info.priceFormatted} · ` : ''}
                    {Math.round(item.widthMm)} × {Math.round(item.depthMm)} mm
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="spl-btn spl-wait-remove"
                aria-label={`Take ${name} off the waiting list`}
                onClick={() => props.onRemove(item.id)}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

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
  onRotate: (ids: string[], deltaDeg: number) => void
  onDelete: (ids: string[]) => void
  onDuplicate: (ids: string[]) => void
  onArray: (id: string, count: number, spacingMm: number, alongYaw: number) => void
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

      <p className="spl-note spl-size-line">
        {Math.round(first.widthMm)} × {Math.round(first.depthMm)} × {Math.round(first.heightMm)} mm
      </p>

      {(first.sizeSource === 'category_default' || first.sizeSource === 'marker') && (
        <p className="spl-note">
          We do not have exact measurements for this one, so the size shown is typical for its category.
        </p>
      )}

      <div className="spl-buttons">
        {/* Through the rotate action rather than as a field edit, so whatever is
            mounted on it or tucked under it comes round with it. */}
        <button type="button" className="spl-btn" onClick={() => props.onRotate([first.id], 90)}>Turn 90°</button>
        <button type="button" className="spl-btn" onClick={() => props.onDuplicate(props.state.selection)}>Duplicate</button>
        {/* Spaced along the direction the thing is FACING, by the dimension it
            actually presents that way. Both were hardcoded: the row always ran
            east, spaced by the item's width, so turning a desk 90 degrees with
            the button immediately beside this one and then pressing Row of four
            laid the copies out along an axis the desk no longer measured that
            way - straight into the clash warning for anything deeper than it is
            wide. Yaw is clockwise from "north", which is -y, so a yaw of 0 runs
            along +x for a rotation of 90. */}
        <button
          type="button"
          className="spl-btn"
          onClick={() => {
            const alongYaw = normaliseYaw(first.yaw)
            const across = Math.abs(Math.cos((alongYaw * Math.PI) / 180)) > 0.5 ? first.widthMm : first.depthMm
            props.onArray(first.id, 3, across + 100, alongYaw)
          }}
        >
          Row of four
        </button>
        <button type="button" className="spl-btn spl-btn-danger" onClick={() => props.onDelete(props.state.selection)}>Remove</button>
      </div>
    </div>
  )
}

/**
 * A number, typed rather than dispatched keystroke by keystroke.
 *
 * Held as text while the field has focus, exactly as LengthField does, and for a
 * worse reason: this one moves the selected item. Clearing the box to retype
 * read as `Number('') === 0` and teleported the desk to the top-left corner of
 * the room, a leading minus sign could not be typed at all, and every digit on
 * the way to "1200" banked its own undo step.
 */
function NumberField(props: { label: string; value: number; onChange: (value: number) => void }) {
  const id = useId()
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)

  const commit = (raw: string) => {
    const value = Number(raw.trim())
    if (raw.trim() !== '' && Number.isFinite(value)) props.onChange(value)
  }

  return (
    <div className="spl-field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        className="spl-input"
        type="number"
        value={editing ? text : String(Math.round(props.value))}
        onFocus={() => { setText(String(Math.round(props.value))); setEditing(true) }}
        onChange={(event) => setText(event.target.value)}
        onBlur={(event) => { setEditing(false); commit(event.target.value) }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      />
    </div>
  )
}

/**
 * The item list, which doubles as the accessible representation of the scene:
 * everything in the room, enumerated, with its size. A screen reader gets the
 * whole plan from this table, and so does the printer.
 */
function ItemListPanel(props: {
  items: PlanItem[]
  products: Record<string, ProductInfo>
  disclaimer: string
  /** What the shop says about its prices. Absent on the printed sheet, which
   * carries the same wording from the server. */
  priceDisclaimer?: string
  currencySymbol: string
  selection?: string[]
  onSelect?: (ids: string[]) => void
}) {
  // Which placed items each line stands for, so tapping a line can pick them
  // out on the plan. A companion has no items of its own - it rides inside its
  // main item's model - so its line has nothing to select, which is why the
  // quantities come from the shared count rather than from this map.
  const groups = new Map<string, string[]>()
  for (const item of props.items) {
    const ids = groups.get(item.productId) ?? []
    ids.push(item.id)
    groups.set(item.productId, ids)
  }

  // The same rule the PDF, the email and the quote price against, so the number
  // on screen and the number on the paperwork cannot disagree.
  const counts = countPlanProducts(props.items)
  if (counts.size === 0) return <p className="spl-note">Nothing in the room yet.</p>

  const rows = [...counts.entries()]
  const total = rows.reduce((sum, [productId, quantity]) => sum + (props.products[productId]?.price ?? 0) * quantity, 0)
  const itemCount = rows.reduce((sum, [, quantity]) => sum + quantity, 0)
  const anyPriced = rows.some(([productId]) => (props.products[productId]?.price ?? 0) > 0)
  // A listing priced through its variations quotes a "from". Multiplying that
  // into a line total states a price the shop has not agreed to, so where one is
  // in the room the totals are marked as the lowest it could be rather than
  // presented as the figure.
  const anyFrom = rows.some(([productId]) => props.products[productId]?.priceVaries)
  const selectedSet = new Set(props.selection ?? [])
  const onSelect = props.onSelect

  return (
    <div className="spl-stack">
      <table className="spl-bom">
        <caption className="spl-note" style={{ textAlign: 'left', paddingBottom: '0.3rem' }}>
          {onSelect ? 'Everything in the room - tap a line to pick those items out on the plan.' : 'Everything in the room'}
        </caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="spl-num">Qty</th>
            <th scope="col" className="spl-num">Each</th>
            <th scope="col" className="spl-num">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([productId, quantity]) => {
            const ids = groups.get(productId) ?? []
            const selectable = onSelect && ids.length > 0
            const allSelected = ids.length > 0 && ids.every((id) => selectedSet.has(id))
            const each = props.products[productId]?.price ?? 0
            const name = props.products[productId]?.name ?? 'Item'
            return (
              <tr
                key={productId}
                className={selectable ? `spl-bom-row${allSelected ? ' is-selected' : ''}` : undefined}
                onClick={selectable ? () => onSelect(allSelected ? [] : ids) : undefined}
              >
                <td>
                  {selectable ? (
                    <button
                      type="button"
                      className="spl-bom-select"
                      aria-pressed={allSelected}
                      onClick={(event) => { event.stopPropagation(); onSelect(allSelected ? [] : ids) }}
                    >
                      {name}
                    </button>
                  ) : (
                    name
                  )}
                </td>
                <td className="spl-num">{quantity}</td>
                <td className="spl-num">{props.products[productId]?.priceFormatted ?? '-'}</td>
                {/* The line total is the number a buyer of twelve desks actually
                    wants - "each" alone leaves them doing the twelve-times table
                    against a screen. Where the each is a "from", so is this. */}
                <td className="spl-num">
                  {each > 0
                    ? `${props.products[productId]?.priceVaries ? 'From ' : ''}${formatMoney(each * quantity, props.currencySymbol)}`
                    : '-'}
                </td>
              </tr>
            )
          })}
        </tbody>
        {anyPriced && (
          <tfoot>
            <tr>
              <td>Roughly</td>
              <td className="spl-num">{itemCount}</td>
              <td className="spl-num" />
              <td className="spl-num">{`${anyFrom ? 'From ' : ''}${formatMoney(total, props.currencySymbol)}`}</td>
            </tr>
          </tfoot>
        )}
      </table>
      {anyPriced && props.priceDisclaimer && <p className="spl-note">{props.priceDisclaimer}</p>}
      <p className="spl-note">{props.disclaimer}</p>
    </div>
  )
}
