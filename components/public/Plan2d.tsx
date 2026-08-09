'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { boundingBox, distanceToWallAlong, itemCorners, offsetAlongWall, openingSpan, pointInPolygon, rotatePoint, walls } from '@/modules/space-planner-for-shop/lib/geometry'
import { formatLength } from '@/modules/space-planner-for-shop/lib/units'
import type { OpeningKind, PlanItem, RoomGeometry, Vertex, WallOpening } from '@/modules/space-planner-for-shop/lib/types'

// The top-down plan. This is the front door and the surface everybody touches
// first, so it gets the polish budget - and it is plain 2D canvas, which means
// it keeps working on a device with no WebGL at all.
//
// Everything it can do by dragging is also reachable as a number in the
// properties panel, which is what makes the accessibility position honest rather
// than aspirational: the canvas is never the only way to accomplish anything.
//
// Three interactions share one pointer, and the order they are resolved in is
// the whole trick: grab an item and you drag it; grab bare floor and you pan;
// let go of bare floor without having moved, next to a wall, and you get the
// wall's length to type. A click is only ever a click if nothing moved.
//
// The same canvas is also the room's own editor. `mode` swaps what the pointer
// means rather than putting a second surface beside the first: FURNISH arranges
// the furniture, SHAPE drags the corners of the room itself, and DRAW puts a new
// outline down from scratch. Rooms are not rectangles - offices have bays,
// chimney breasts and returns - so an outline of any number of walls is the
// point of the tool rather than a refinement of it.

export type PlanMode = 'furnish' | 'shape' | 'draw' | 'openings' | 'obstructions'

/** The colours one drawing pass uses. See renderScene - the screen and the PDF
 * capture draw the identical scene with different answers here. */
type PlanPalette = { ink: string; muted: string; line: string; accent: string; surface: string; danger: string }

/** Ink on paper, for the PDF: whatever theme the site wears, the capture draws
 * in daylight. A dark-mode shopper exporting a plan used to be handed a black
 * floor on white paper. */
const EXPORT_PALETTE: PlanPalette = {
  ink: '#16181a',
  muted: 'rgba(22, 24, 26, 0.72)',
  line: '#c9cdd2',
  accent: '#2f6fed',
  surface: '#ffffff',
  danger: '#b3261e',
}

export type Plan2dProps = {
  geometry: RoomGeometry
  items: PlanItem[]
  selection: string[]
  labels: Record<string, string>
  clashes: Array<{ a: string; b: string }>
  /** Millimetres. Zero switches the clearance guides off. */
  walkwayClearanceMm: number
  mode: PlanMode
  onSelect: (ids: string[]) => void
  onDragItems: (ids: string[], dx: number, dy: number, snap: boolean) => void
  /** Turning the selected item by its handle. Degrees, relative to where it is now. */
  onRotateItems: (ids: string[], deltaDeg: number, snap: boolean) => void
  /**
   * A gesture is starting.
   *
   * This is where the undo step belongs. Banking it on release records the state
   * the drag PRODUCED, so the first press of undo appeared to do nothing at all
   * and the second one went back too far.
   */
  onDragStart: () => void
  onDragEnd: () => void
  onWallClick: (wallIndex: number, currentLengthMm: number) => void
  /** A new outline. `settle` marks the end of a gesture - see the reducer. */
  onShape: (vertices: Vertex[], settle: boolean) => void
  /** A finished drawing, in plan millimetres, wound in the order it was drawn. */
  onDrawDone: (vertices: Vertex[]) => void
  onDrawCancel: () => void
  onDropAt?: (x: number, y: number) => void

  // ---- doors and windows -------------------------------------------------
  /** Which opening is being edited, and what a fresh one would be. */
  openingSelection?: string | null
  openingKind?: OpeningKind
  /** A tap on bare wall in openings mode: put one here, centred on the tap. */
  onAddOpening?: (wallIndex: number, offsetMm: number) => void
  onSelectOpening?: (id: string | null) => void
  /** Sliding one along its own wall. Millimetres from that wall's start. */
  onMoveOpening?: (id: string, offsetMm: number) => void

  // ---- columns and other obstructions -------------------------------------
  /** Which obstruction is being edited, while the mode is 'obstructions'. */
  obstructionSelection?: string | null
  /** A tap on clear floor in obstructions mode: put one here, centred on the tap. */
  onAddObstruction?: (x: number, y: number) => void
  onSelectObstruction?: (id: string | null) => void
  /** Dragging one about. Millimetre deltas, like the furniture. */
  /** `settle` marks the end of the gesture - see the reducer's move-obstruction. */
  onMoveObstruction?: (id: string, dx: number, dy: number, settle?: boolean) => void

  /** Hands the parent a way to photograph the plan, for the PDF export. */
  registerCapture?: (capture: (() => string | null) | null) => void
}

type View = { scale: number; offsetX: number; offsetY: number }

const PADDING = 44
/** How near a wall a click has to land, in screen pixels, to mean "edit this wall". */
const WALL_HIT_PX = 18
/** How near a corner counts as grabbing it, in screen pixels. Generous: fingers. */
const CORNER_HIT_PX = 16
/** How far beyond the front edge the turn handle floats, in screen pixels. */
const ROTATE_HANDLE_PX = 30
/** How near the turn handle a press has to land. Bigger than a corner: it is smaller. */
const ROTATE_HIT_PX = 18
/** What the turn handle rounds to unless the override key is held. */
const ROTATE_SNAP_DEG = 15
const MIN_ZOOM = 0.25
const MAX_ZOOM = 6
/** Everything drawn lands on a 10 mm grid. Nobody measures a room to the millimetre. */
const DRAW_SNAP_MM = 10
/**
 * A blank canvas needs a size, and it cannot come from the room being replaced -
 * that is what is being thrown away. Sixteen metres by twelve covers the offices
 * this shop furnishes with room to spare, and the zoom and pan cover the rest.
 */
const DRAW_CANVAS: Vertex[] = [
  { x: 0, y: 0 },
  { x: 16_000, y: 0 },
  { x: 16_000, y: 12_000 },
  { x: 0, y: 12_000 },
]

export function Plan2d(props: Plan2dProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<View>({ scale: 0.05, offsetX: PADDING, offsetY: PADDING })
  // Read by the pointer handlers, which run outside render and must see the
  // current view without being rebound on every pan frame.
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])
  /** The scale a plain fit produces. User zoom is expressed as a multiple of it. */
  const fitScaleRef = useRef(0.05)
  /**
   * How far the shopper has zoomed in on top of the fit, as a multiple.
   *
   * Held on its own rather than recovered from the current scale. Recovering it
   * means dividing one piece of state that React has already updated by another
   * that it has not, and a ResizeObserver - which fires the moment you observe,
   * before the render carrying the first value has landed - reads the pair
   * mid-flight and zooms the room down to a postage stamp.
   */
  const zoomRef = useRef(1)
  const dragRef = useRef<{
    kind: 'items' | 'pan'
    ids: string[]
    startX: number
    startY: number
    lastX: number
    lastY: number
    moved: boolean
  } | null>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null)
  /** The turn in progress: which item, where it and the pointer started, and how far it has come. */
  const rotateRef = useRef<{ id: string; startYaw: number; startAngleDeg: number; appliedDeg?: number } | null>(null)
  /** The door or window being slid along its wall. */
  const openingDragRef = useRef<{ id: string; wallIndex: number; grabOffsetMm: number; moved: boolean } | null>(null)
  /** The column being dragged across the floor. */
  const obstructionDragRef = useRef<{ id: string; lastX: number; lastY: number; moved: boolean } | null>(null)
  /** The corner being edited in shape mode, and the outline being drawn in draw mode. */
  const [corner, setCorner] = useState<number | null>(null)
  const cornerDragRef = useRef<number | null>(null)
  /** Whether the grabbed corner has actually gone anywhere - a click on a corner
   * is a selection, and settling (or undo-banking) a drag that never happened
   * marked the plan dirty for looking at it. */
  const cornerMovedRef = useRef(false)
  const [draft, setDraft] = useState<Vertex[]>([])
  /** The corners drawn so far, for the keyboard handler to read without
   * reaching for them from inside a setDraft updater - StrictMode runs those
   * twice, and finishing the room is not something to do twice. */
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  })
  const [hover, setHover] = useState<Vertex | null>(null)

  // Fit the room to the canvas. Recomputed whenever the room or the box changes,
  // because a shopper who has just typed a wall length expects to see the result
  // rather than to go looking for it. Any zoom they had applied is kept.
  const fit = useCallback(
    (reset: boolean) => {
      const canvas = canvasRef.current
      const wrap = wrapRef.current
      if (!canvas || !wrap) return
      const width = wrap.clientWidth
      const height = wrap.clientHeight
      if (width < 2 || height < 2) return
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.floor(width * ratio))
      canvas.height = Math.max(1, Math.floor(height * ratio))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`

      const box = boundingBox(props.mode === 'draw' ? DRAW_CANVAS : props.geometry.vertices)
      const roomWidth = Math.max(1, box.maxX - box.minX)
      const roomHeight = Math.max(1, box.maxY - box.minY)
      const pad = Math.min(PADDING, Math.min(width, height) * 0.12)
      const fitScale = Math.max(
        1e-6,
        Math.min((width - pad * 2) / roomWidth, (height - pad * 2) / roomHeight),
      )
      if (reset) zoomRef.current = 1
      fitScaleRef.current = fitScale
      const scale = fitScale * zoomRef.current
      setView({
        scale,
        offsetX: (width - roomWidth * scale) / 2 - box.minX * scale,
        offsetY: (height - roomHeight * scale) / 2 - box.minY * scale,
      })
    },
    [props.geometry, props.mode],
  )

  useEffect(() => {
    // Not while ANY gesture that edits the room is under the pointer.
    //
    // Re-fitting keys on the room, and these three change the room on every
    // pointer event - so the view recentred, and the canvas was resized (and so
    // cleared) between every pair of them. The room crawled out from under the
    // cursor as it was dragged.
    //
    // Corners were guarded when that was noticed; columns and doors were not,
    // and they are worse off, because their drag arithmetic is in plan
    // coordinates read back through the view. Recentring mid-drag discards the
    // pan, so the NEXT pointer move measured a delta the size of the pan that
    // had just been thrown away and the column jumped that far in one frame.
    // Panning the plan to find a column - which on a phone is the only way to
    // reach one - and then dragging it was therefore reliably wrong.
    if (cornerDragRef.current !== null || obstructionDragRef.current !== null || openingDragRef.current !== null) return
    fit(false)
  }, [fit])

  // Leaving a mode clears whatever that mode was holding, so coming back to it
  // starts clean rather than resuming a gesture from ten minutes ago. Adjusted
  // during render rather than in an effect: React re-runs this component before
  // anything is painted, so the canvas never gets a frame showing the last
  // mode's half-drawn outline.
  const [lastMode, setLastMode] = useState(props.mode)
  if (lastMode !== props.mode) {
    setLastMode(props.mode)
    setCorner(null)
    setDraft([])
    setHover(null)
  }

  // The observer below is mount-only and must not rebind on every geometry or
  // mode change, so its callback can only ever close over the `fit` that
  // existed at mount. Routing the call through a ref refreshed every render is
  // what lets the subscription stay mount-only while still calling a fit that
  // matches the room as it is now - a phone rotation or a breakpoint change
  // right after an edit used to re-fit against the shape or mode that was
  // current when the component first mounted.
  const fitRef = useRef(fit)
  useEffect(() => {
    fitRef.current = fit
  })

  useEffect(() => {
    const observer = new ResizeObserver(() => fitRef.current(false))
    if (wrapRef.current) observer.observe(wrapRef.current)
    return () => observer.disconnect()
    // Deliberately not keyed on anything: the observer only has to exist once,
    // and it reaches `fit` through the ref above rather than by closing over
    // it, so exhaustive-deps has nothing to ask for here.
  }, [])

  const removeCorner = useCallback(
    (index: number) => {
      if (props.geometry.vertices.length <= 3) return
      props.onShape(props.geometry.vertices.filter((_, at) => at !== index), true)
      setCorner(null)
    },
    [props],
  )

  useEffect(() => {
    if (props.mode === 'furnish') return
    const handler = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      // Enter belongs to whatever has the focus. This listener is on the window
      // and calls preventDefault, so while drawing, Enter on a focused "Back a
      // corner", "Cancel" or catalogue card closed the room off instead of doing
      // the thing the button says. Only Enter: Escape and Backspace press
      // nothing, and they have to keep working wherever the focus happens to be.
      if (event.key === 'Enter' && target?.closest('button, a, [role="button"]')) return
      if (props.mode === 'draw') {
        if (event.key === 'Backspace') {
          event.preventDefault()
          setDraft((current) => current.slice(0, -1))
        } else if (event.key === 'Enter') {
          event.preventDefault()
          const drawn = draftRef.current
          if (drawn.length >= 3) props.onDrawDone(drawn)
        } else if (event.key === 'Escape') {
          props.onDrawCancel()
        }
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && corner !== null) {
        event.preventDefault()
        removeCorner(corner)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [props, corner, removeCorner])

  const toScreen = useCallback((point: Vertex) => ({ x: point.x * view.scale + view.offsetX, y: point.y * view.scale + view.offsetY }), [view])
  const toPlan = useCallback((x: number, y: number) => ({ x: (x - view.offsetX) / view.scale, y: (y - view.offsetY) / view.scale }), [view])

  /**
   * The one item a turn handle would belong to.
   *
   * One at a time and placed only: a handle on every item in a multi-selection
   * is six things to press by accident, and a handle on something still in the
   * tray points at nothing.
   */
  const sole =
    props.mode === 'furnish' && props.selection.length === 1
      ? props.items.find((item) => item.id === props.selection[0] && !item.staged) ?? null
      : null

  /** Zoom about a fixed screen point, so the thing under the cursor stays under it. */
  const zoomAt = useCallback((factor: number, screenX: number, screenY: number) => {
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomRef.current * factor))
    zoomRef.current = nextZoom
    setView((current) => {
      const scale = fitScaleRef.current * nextZoom
      if (scale === current.scale) return current
      const planX = (screenX - current.offsetX) / current.scale
      const planY = (screenY - current.offsetY) / current.scale
      return { scale, offsetX: screenX - planX * scale, offsetY: screenY - planY * scale }
    })
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Registered by hand, and NOT passive. React attaches wheel at the root as a
    // passive listener, so preventDefault from a JSX onWheel handler is ignored
    // and the page scrolled away underneath the plan while somebody zoomed it.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  /**
   * Draw the whole plan with a given set of colours.
   *
   * Parameterised on the palette rather than reading the theme inside, because
   * it has two callers who want different answers: the screen draws in the
   * site's own colours, and the PDF capture draws the identical scene in
   * EXPORT_PALETTE's ink-on-paper - see the capture effect below.
   */
  const renderScene = useCallback((context: CanvasRenderingContext2D, palette: PlanPalette) => {
    const { ink, muted, line, accent, surface, danger } = palette

    // In draw mode the old room is gone from the canvas entirely. Leaving it
    // underneath while somebody draws a new one is the fastest way to have them
    // trace the shape they were trying to replace.
    const drawing = props.mode === 'draw'
    const outline = drawing ? DRAW_CANVAS : props.geometry.vertices

    // Floor
    context.beginPath()
    outline.forEach((vertex, index) => {
      const point = toScreen(vertex)
      if (index === 0) context.moveTo(point.x, point.y)
      else context.lineTo(point.x, point.y)
    })
    context.closePath()
    context.fillStyle = surface
    context.fill()

    // A metre grid inside the floor. It is what turns an outline into something
    // a person can judge distances against without measuring anything, and it
    // costs two dozen lines clipped to the room.
    context.save()
    context.clip()
    const gridMm = view.scale * 1000 < 26 ? 5000 : view.scale * 1000 > 90 ? 500 : 1000
    const box = boundingBox(outline)
    context.strokeStyle = withAlpha(line, 0.55)
    context.lineWidth = 1
    context.beginPath()
    for (let x = Math.ceil(box.minX / gridMm) * gridMm; x <= box.maxX; x += gridMm) {
      const at = toScreen({ x, y: box.minY })
      context.moveTo(Math.round(at.x) + 0.5, toScreen({ x, y: box.minY }).y)
      context.lineTo(Math.round(at.x) + 0.5, toScreen({ x, y: box.maxY }).y)
    }
    for (let y = Math.ceil(box.minY / gridMm) * gridMm; y <= box.maxY; y += gridMm) {
      const at = toScreen({ x: box.minX, y })
      context.moveTo(toScreen({ x: box.minX, y }).x, Math.round(at.y) + 0.5)
      context.lineTo(toScreen({ x: box.maxX, y }).x, Math.round(at.y) + 0.5)
    }
    context.stroke()
    context.restore()

    if (drawing) {
      drawDraft(context, draft, hover, toScreen, { ink, accent, muted, surface, units: props.geometry.units })
      return
    }

    // Walls, with the door and window gaps drawn as breaks rather than as lines
    // over the top - a plan where the doorway is a thin rectangle is a plan
    // people misread.
    context.lineWidth = Math.max(3, props.geometry.wallThicknessMm * view.scale)
    context.strokeStyle = ink
    context.lineCap = 'butt'
    for (const wall of walls(props.geometry.vertices)) {
      const gaps = props.geometry.openings
        .filter((opening) => opening.wallIndex === wall.index)
        .map((opening) => openingSpan(props.geometry, opening))
        .filter((span): span is NonNullable<typeof span> => span !== null)

      let cursor = wall.a
      for (const gap of gaps) {
        drawSegment(context, toScreen(cursor), toScreen(gap.start))
        cursor = gap.end
      }
      drawSegment(context, toScreen(cursor), toScreen(wall.b))
    }

    // Wall lengths, written just inside the room. Centred on the wall they would
    // sit half off the canvas on the left and right walls, which is exactly what
    // they used to do.
    for (const wall of walls(props.geometry.vertices)) {
      const midPlan = { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 }
      const inward = inwardNormal(props.geometry.vertices, wall.a, wall.b, midPlan)
      const mid = toScreen(midPlan)
      const text = formatLength(wall.lengthMm, props.geometry.units)
      context.save()
      context.font = '500 12px system-ui, sans-serif'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      // Clear of the wall band, not merely inside the room: the wall is drawn as
      // a thick stroke centred on the line, so a fixed sixteen pixels put the
      // label half on top of it at anything but a small zoom.
      const clearance = 14 + (props.geometry.wallThicknessMm * view.scale) / 2
      const at = { x: mid.x + inward.x * clearance, y: mid.y + inward.y * clearance }
      const boxWidth = context.measureText(text).width + 10
      context.fillStyle = withAlpha(surface, 0.85)
      context.fillRect(at.x - boxWidth / 2, at.y - 8, boxWidth, 16)
      context.fillStyle = muted
      context.fillText(text, at.x, at.y)
      context.restore()
    }

    // Obstructions: columns, chimney breasts, stair boxes. Filled faintly so
    // they read as floor nothing can stand on rather than as a decorative
    // outline; solid and accented while the one in question is being edited.
    for (const obstruction of props.geometry.obstructions) {
      // Accented while it is the thing being edited, which is now either mode:
      // a column can be picked out of the ordinary furnishing view as well as
      // from its own. Not in the shape, drawing or openings modes though -
      // there the selection is a leftover, and highlighting it would be the
      // plan pointing at something the toolbar is not talking about.
      const editing =
        (props.mode === 'obstructions' || props.mode === 'furnish') && props.obstructionSelection === obstruction.id
      context.beginPath()
      obstruction.vertices.forEach((vertex, index) => {
        const point = toScreen(vertex)
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      })
      context.closePath()
      context.fillStyle = editing ? withAlpha(accent, 0.14) : withAlpha(line, 0.45)
      context.fill()
      context.setLineDash(editing ? [] : [6, 4])
      context.lineWidth = editing ? 2 : 1.5
      context.strokeStyle = editing ? accent : muted
      context.stroke()
      context.setLineDash([])

      const obox = boundingBox(obstruction.vertices)
      const pxWidth = (obox.maxX - obox.minX) * view.scale
      const pxHeight = (obox.maxY - obox.minY) * view.scale
      if (Math.min(pxWidth, pxHeight) > 26) {
        context.save()
        context.fillStyle = editing ? accent : muted
        context.font = '500 11px system-ui, sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        const centre = toScreen({ x: (obox.minX + obox.maxX) / 2, y: (obox.minY + obox.maxY) / 2 })
        context.fillText(ellipsise(context, obstruction.label || 'Column', Math.max(pxWidth, pxHeight) - 8), centre.x, centre.y)
        context.restore()
      }
    }

    // Items
    const clashing = new Set(props.clashes.flatMap((clash) => [clash.a, clash.b]))
    for (const item of props.items) {
      if (item.staged) continue
      const corners = itemCorners(item).map(toScreen)
      const selected = props.selection.includes(item.id)
      context.beginPath()
      corners.forEach((corner, index) => {
        if (index === 0) context.moveTo(corner.x, corner.y)
        else context.lineTo(corner.x, corner.y)
      })
      context.closePath()
      context.fillStyle = selected ? withAlpha(accent, 0.18) : withAlpha(line, 0.5)
      context.fill()
      context.lineWidth = selected ? 2 : 1
      context.strokeStyle = clashing.has(item.id) ? danger : selected ? accent : ink
      // A guessed size is DRAWN as a guess: dashed, with "≈" on the number.
      // The wrong-size furniture that looks authoritative is how a plan lies.
      const approximate = (item.sizeSource === 'marker' || item.sizeSource === 'category_default') && !item.manualSize
      if (approximate) context.setLineDash([5, 4])
      context.stroke()
      if (approximate) context.setLineDash([])

      // Which way it faces. Without it a desk and a desk turned round are the
      // same rectangle, and the room reads wrong in 3D for reasons nobody can
      // see on the plan.
      drawFacingMark(context, item, toScreen, selected ? accent : muted)

      const label = props.labels[item.productId]
      const boxWidth = item.widthMm * view.scale
      const boxHeight = item.depthMm * view.scale
      if (label && Math.min(boxWidth, boxHeight) > 26) {
        context.save()
        context.fillStyle = ink
        context.font = '500 11px system-ui, sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        const centre = toScreen({ x: item.x, y: item.y })
        const room = Math.max(boxWidth, boxHeight) - 8
        const fitted = ellipsise(context, label, room)
        const showSize = Math.min(boxWidth, boxHeight) > 44
        context.fillText(fitted, centre.x, showSize ? centre.y - 6 : centre.y)
        if (showSize) {
          context.fillStyle = muted
          context.font = '400 10px system-ui, sans-serif'
          context.fillText(`${approximate ? '≈ ' : ''}${Math.round(item.widthMm)} × ${Math.round(item.depthMm)}`, centre.x, centre.y + 7)
        }
        context.restore()
      }
    }

    // What the selected thing has around it, in numbers. A gap you can see is a
    // guess; a gap with 780 written on it is a decision.
    if (sole) {
      drawClearances(context, sole, props.geometry, toScreen, {
        accent,
        muted,
        danger,
        surface,
        warnBelowMm: props.walkwayClearanceMm,
        units: props.geometry.units,
      })
      drawRotateHandle(context, sole, view.scale, toScreen, { accent, surface })
    }

    // Doors and windows, while they are the thing being edited. The wall stroke
    // already breaks around them - that is the plan-reading convention and it
    // stays - so this adds only what an editor needs: something to grab, and
    // which one is selected.
    if (props.mode === 'openings') {
      for (const opening of props.geometry.openings) {
        const span = openingSpan(props.geometry, opening)
        const centre = openingCentre(props.geometry, opening)
        if (!span || !centre) continue
        const selected = props.openingSelection === opening.id
        const from = toScreen(span.start)
        const to = toScreen(span.end)
        const at = toScreen(centre)

        context.save()
        context.strokeStyle = selected ? accent : muted
        // A window keeps the glazing line convention; a door and a plain gap are
        // drawn open, because that is what they are.
        context.lineWidth = opening.kind === 'window' ? 4 : 3
        context.setLineDash(opening.kind === 'door' ? [5, 4] : [])
        drawSegment(context, from, to)
        context.setLineDash([])

        context.beginPath()
        context.arc(at.x, at.y, 6, 0, Math.PI * 2)
        context.fillStyle = selected ? accent : surface
        context.fill()
        context.lineWidth = 2
        context.strokeStyle = selected ? accent : ink
        context.stroke()
        context.restore()
      }
    }

    // The corners themselves, once somebody is editing the room rather than what
    // is standing in it. Only in shape mode: handles on every corner all the time
    // would be six more things to hit by accident while dragging a desk.
    if (props.mode === 'shape') {
      props.geometry.vertices.forEach((vertex, index) => {
        const at = toScreen(vertex)
        const active = corner === index
        context.beginPath()
        context.rect(at.x - 6, at.y - 6, 12, 12)
        context.fillStyle = active ? accent : surface
        context.fill()
        context.lineWidth = 2
        context.strokeStyle = active ? accent : ink
        context.stroke()
      })
    }
  }, [props.geometry, props.items, props.selection, props.labels, props.clashes, props.walkwayClearanceMm, props.mode, props.openingSelection, props.obstructionSelection, sole, corner, draft, hover, view, toScreen])

  /** One painted frame: transform, wipe, optional paper background, scene. */
  const paint = useCallback(
    (canvas: HTMLCanvasElement, palette: PlanPalette, background: string | null) => {
      const context = canvas.getContext('2d')
      if (!context) return
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const width = canvas.width / ratio
      const height = canvas.height / ratio
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      if (background) {
        context.fillStyle = background
        context.fillRect(0, 0, width, height)
      }
      renderScene(context, palette)
    },
    [renderScene],
  )

  // A canvas does not inherit a theme; it is painted with whatever the tokens
  // said at the moment it was painted.
  //
  // The repaint above keys on the geometry, the items, the selection and the
  // view - none of which a theme switch touches. And the switch itself happens
  // entirely outside React, as a data-theme attribute on <html>, so nothing in
  // this component had any idea it had happened: the stage around the plan
  // flipped to dark instantly and the plan kept its light-theme ink, at about
  // 1.1:1 on the new background, until an unrelated pan or click forced a
  // redraw. Both signals are watched because the platform has two - the
  // attribute for an explicit choice, and the media query for "follow the
  // system".
  const [themeNonce, setThemeNonce] = useState(0)
  useEffect(() => {
    const bump = () => setThemeNonce((value) => value + 1)
    const observer = new MutationObserver(bump)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', bump)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', bump)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const style = getComputedStyle(canvas)
    const ink = style.getPropertyValue('--color-text').trim() || '#111'
    paint(
      canvas,
      {
        ink,
        // Derived from the ink rather than read from --color-text-muted: the
        // muted token is a decorative grey that measures about 2.4:1 on this
        // theme's background, and dimension figures on a plan are the last text
        // on the site that should be hard to read. Fading the real text colour
        // keeps it theme-following and lands well inside AA in light and dark.
        muted: withAlpha(ink, 0.72),
        line: style.getPropertyValue('--color-border').trim() || '#ccc',
        accent: style.getPropertyValue('--color-primary').trim() || '#2f6fed',
        surface: style.getPropertyValue('--color-bg').trim() || '#fff',
        danger: style.getPropertyValue('--color-danger').trim() || '#b3261e',
      },
      null,
    )
  }, [paint, themeNonce])

  useEffect(() => {
    const register = props.registerCapture
    if (!register) return
    // The same scene painted onto an offscreen canvas in EXPORT_PALETTE, never a
    // read-back of the screen: the screen wears the site's theme, and a plan
    // captured off a dark theme printed as a black page.
    register(() => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const off = document.createElement('canvas')
      off.width = canvas.width
      off.height = canvas.height
      paint(off, EXPORT_PALETTE, '#ffffff')
      try {
        return off.toDataURL('image/png')
      } catch {
        return null
      }
    })
    return () => register(null)
  }, [props.registerCapture, paint])

  const hitTest = useCallback(
    (x: number, y: number): PlanItem | null => {
      const point = toPlan(x, y)
      // Topmost first, so the thing drawn on top is the thing you grab.
      for (let i = props.items.length - 1; i >= 0; i--) {
        const item = props.items[i]
        if (!item || item.staged) continue
        if (pointInCorners(point, itemCorners(item))) return item
      }
      return null
    },
    [props.items, toPlan],
  )

  function localPoint(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  /** Where a drawn point lands: on the 10 mm grid, and square to the last one. */
  const snapDraw = useCallback(
    (point: Vertex, previous: Vertex | undefined): Vertex => {
      const round = (value: number) => Math.round(value / DRAW_SNAP_MM) * DRAW_SNAP_MM
      if (!previous) return { x: round(point.x), y: round(point.y) }
      const dx = point.x - previous.x
      const dy = point.y - previous.y
      // Rooms are overwhelmingly square, so a wall within a few degrees of
      // straight is meant to be straight. The 45s are for the bays.
      const angle = Math.atan2(dy, dx)
      const step = Math.PI / 4
      const nearest = Math.round(angle / step) * step
      const length = Math.hypot(dx, dy)
      if (Math.abs(angle - nearest) < 0.12) {
        return { x: round(previous.x + Math.cos(nearest) * length), y: round(previous.y + Math.sin(nearest) * length) }
      }
      return { x: round(point.x), y: round(point.y) }
    },
    [],
  )

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const { x, y } = localPoint(event)
    pointersRef.current.set(event.pointerId, { x, y })

    // A second finger landing ANYWHERE is a pinch, whatever the mode. It used
    // to be recognised only while furnishing, so on a phone the room could not
    // be pinch-zoomed while being drawn - and worse, the second finger's landing
    // was read as another tap: a stray corner in draw mode, a stray door in
    // openings mode, a stray column in obstructions mode. Whatever the first
    // finger had started is abandoned; anything it had already moved is closed
    // off properly, so the undo step and the unsaved-work flag are not lost.
    // `>= 2`, not `=== 2`: with two fingers already down a third landed
    // straight through this guard into the mode handlers below and set up a
    // fresh drag, which on release read as a tap - the exact stray corner, door
    // or column the guard exists to stop. A palm or a third finger during a
    // pinch is not a rare way to hold a phone.
    if (pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()]
      if (a && b) pinchRef.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoomRef.current }
      if (dragRef.current?.kind === 'items' && dragRef.current.moved) props.onDragEnd()
      dragRef.current = null
      if ((rotateRef.current?.appliedDeg ?? 0) !== 0) props.onDragEnd()
      rotateRef.current = null
      if (openingDragRef.current?.moved) props.onDragEnd()
      openingDragRef.current = null
      if (obstructionDragRef.current?.moved) {
        props.onMoveObstruction?.(obstructionDragRef.current.id, 0, 0, true)
        props.onDragEnd()
      }
      obstructionDragRef.current = null
      if (cornerDragRef.current !== null) {
        cornerDragRef.current = null
        // Settle only a drag that went somewhere - a grabbed-but-unmoved corner
        // has nothing to tidy, and settling it would mark the plan dirty.
        if (cornerMovedRef.current) props.onShape(props.geometry.vertices, true)
        cornerMovedRef.current = false
      }
      return
    }

    if (props.mode === 'draw') {
      // A tap puts a corner down; a drag pans. Decided on RELEASE rather than
      // on touch - deciding on touch made panning impossible while drawing,
      // and the room being drawn is usually bigger than the phone screen it is
      // being drawn on. See onPointerUp for the corner itself.
      dragRef.current = { kind: 'pan', ids: [], startX: x, startY: y, lastX: x, lastY: y, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    if (props.mode === 'openings') {
      // An existing one first: they sit ON the wall, so a tap near a door is
      // also a tap near the wall, and grabbing what is already there is what
      // somebody aiming at it meant.
      const point = toPlan(x, y)
      const grabbed = props.geometry.openings.find((opening) => {
        const centre = openingCentre(props.geometry, opening)
        if (!centre) return false
        const at = toScreen(centre)
        return Math.hypot(at.x - x, at.y - y) <= CORNER_HIT_PX
      })
      if (grabbed) {
        props.onSelectOpening?.(grabbed.id)
        const along = offsetAlongWall(props.geometry.vertices, grabbed.wallIndex, point)
        openingDragRef.current = {
          id: grabbed.id,
          wallIndex: grabbed.wallIndex,
          // Where along the opening it was grabbed, so it does not jump to
          // centre itself under the finger on the first pixel of the drag.
          grabOffsetMm: along === null ? grabbed.widthMm / 2 : along - grabbed.offsetMm,
          moved: false,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        return
      }
      // Adding happens on release - see onPointerUp - so a drag can pan and a
      // pinch can zoom without either salting the walls with doors.
      dragRef.current = { kind: 'pan', ids: [], startX: x, startY: y, lastX: x, lastY: y, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    if (props.mode === 'obstructions') {
      const point = toPlan(x, y)
      // Topmost first, like the furniture: the one drawn last is the one grabbed.
      const grabbed = [...props.geometry.obstructions].reverse().find((candidate) => pointInCorners(point, candidate.vertices))
      if (grabbed) {
        props.onSelectObstruction?.(grabbed.id)
        obstructionDragRef.current = { id: grabbed.id, lastX: point.x, lastY: point.y, moved: false }
        event.currentTarget.setPointerCapture(event.pointerId)
        return
      }
      // Adding happens on release, so dragging across the floor pans rather
      // than planting a column at the first touch.
      dragRef.current = { kind: 'pan', ids: [], startX: x, startY: y, lastX: x, lastY: y, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    if (props.mode === 'shape') {
      const index = props.geometry.vertices.findIndex((vertex) => {
        const at = toScreen(vertex)
        return Math.hypot(at.x - x, at.y - y) <= CORNER_HIT_PX
      })
      if (index >= 0) {
        setCorner(index)
        cornerDragRef.current = index
        cornerMovedRef.current = false
        event.currentTarget.setPointerCapture(event.pointerId)
        return
      }
      setCorner(null)
      dragRef.current = { kind: 'pan', ids: [], startX: x, startY: y, lastX: x, lastY: y, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    // The turn handle is tested before the furniture, because it floats over the
    // floor and sometimes over a neighbour: whoever is holding it meant to.
    if (sole) {
      const handle = toScreen(rotateHandlePoint(sole, view.scale))
      if (Math.hypot(handle.x - x, handle.y - y) <= ROTATE_HIT_PX) {
        const point = toPlan(x, y)
        rotateRef.current = {
          id: sole.id,
          startYaw: sole.yaw,
          startAngleDeg: (Math.atan2(point.y - sole.y, point.x - sole.x) * 180) / Math.PI,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        return
      }
    }

    const hit = hitTest(x, y)
    if (hit) {
      const ids = event.shiftKey
        ? props.selection.includes(hit.id)
          ? props.selection.filter((id) => id !== hit.id)
          : [...props.selection, hit.id]
        : props.selection.includes(hit.id)
          ? props.selection
          : [hit.id]
      props.onSelect(ids)
      // A column and a desk are never both the thing being edited.
      props.onSelectObstruction?.(null)
      // The undo step is banked when the drag actually MOVES - see
      // onPointerMove. Banking it here recorded a step for every plain
      // selection click, and each one burnt an undo slot on a state identical
      // to the last: press undo after three clicks and nothing appeared to
      // happen three times.
      dragRef.current = { kind: 'items', ids, startX: x, startY: y, lastX: x, lastY: y, moved: false }
    } else {
      // No furniture here - but there may be a column. Tested AFTER the
      // furniture on purpose: a column is a fact about the building and the
      // desk in front of it is the thing being arranged, so where they overlap
      // the click belongs to the desk. Without this a column was scenery the
      // moment it was placed: pickable only from Room -> Columns & pillars, and
      // in the ordinary furnishing mode not clickable at all.
      const point = toPlan(x, y)
      const column = [...props.geometry.obstructions].reverse().find((candidate) => pointInCorners(point, candidate.vertices))
      if (column) {
        props.onSelect([])
        props.onSelectObstruction?.(column.id)
        obstructionDragRef.current = { id: column.id, lastX: point.x, lastY: point.y, moved: false }
        event.currentTarget.setPointerCapture(event.pointerId)
        return
      }
      props.onSelectObstruction?.(null)
      dragRef.current = { kind: 'pan', ids: [], startX: x, startY: y, lastX: x, lastY: y, moved: false }
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const { x, y } = localPoint(event)
    if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, { x, y })

    if (props.mode === 'draw' && !dragRef.current && !pinchRef.current) {
      // The dashed preview wall, following a pointer that is merely hovering.
      // While a finger or button is down the gesture below owns the pointer.
      setHover(snapDraw(toPlan(x, y), draft[draft.length - 1]))
      return
    }

    const sliding = openingDragRef.current
    if (sliding) {
      const along = offsetAlongWall(props.geometry.vertices, sliding.wallIndex, toPlan(x, y))
      if (along !== null) {
        // The undo step is banked on the first real movement, not on the grab:
        // tapping a door to select it used to burn an undo slot and mark the
        // plan dirty without anything having changed.
        if (!sliding.moved) {
          sliding.moved = true
          props.onDragStart()
        }
        props.onMoveOpening?.(sliding.id, Math.round(along - sliding.grabOffsetMm))
      }
      return
    }

    const carrying = obstructionDragRef.current
    if (carrying) {
      const point = toPlan(x, y)
      const dx = point.x - carrying.lastX
      const dy = point.y - carrying.lastY
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      carrying.lastX = point.x
      carrying.lastY = point.y
      if (!carrying.moved) {
        carrying.moved = true
        props.onDragStart()
      }
      props.onMoveObstruction?.(carrying.id, dx, dy)
      return
    }

    const turning = rotateRef.current
    if (turning) {
      const point = toPlan(x, y)
      const item = props.items.find((candidate) => candidate.id === turning.id)
      if (!item) return
      const angle = (Math.atan2(point.y - item.y, point.x - item.x) * 180) / Math.PI
      const wanted = turning.startYaw + (angle - turning.startAngleDeg)
      // Holding alt escapes the fifteen-degree steps, the same key that escapes
      // the wall and furniture snaps.
      const target = event.altKey ? wanted : Math.round(wanted / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG
      // Measured against what this gesture has already applied rather than
      // against the item's current angle: state arrives a render later than the
      // pointer does, and a delta taken from a stale angle turns twice.
      const delta = target - turning.startYaw - (turning.appliedDeg ?? 0)
      if (Math.abs(delta) < 0.01) return
      // First actual turn of this gesture: bank the undo step now, so a press
      // on the handle that never turned anything banks nothing.
      if ((turning.appliedDeg ?? 0) === 0) props.onDragStart()
      turning.appliedDeg = (turning.appliedDeg ?? 0) + delta
      props.onRotateItems([turning.id], delta, false)
      return
    }

    const dragging = cornerDragRef.current
    if (dragging !== null) {
      const point = snapDraw(toPlan(x, y), props.geometry.vertices[(dragging + props.geometry.vertices.length - 1) % props.geometry.vertices.length])
      cornerMovedRef.current = true
      const next = props.geometry.vertices.map((vertex, index) => (index === dragging ? point : vertex))
      props.onShape(next, false)
      return
    }

    const pinch = pinchRef.current
    // Also `>= 2`, to match the guard that armed it: an exact test meant a
    // third finger froze the zoom until every finger came off. The first two in
    // the map are the pair being measured, which is the same pair the pinch was
    // armed from, so it stays steady rather than jumping to a new baseline.
    if (pinch && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()]
      if (!a || !b) return
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinch.distance > 4) {
        const target = (pinch.zoom * distance) / pinch.distance
        zoomAt(target / zoomRef.current, (a.x + b.x) / 2, (a.y + b.y) / 2)
      }
      return
    }

    const drag = dragRef.current
    if (!drag) return
    const dxPx = x - drag.lastX
    const dyPx = y - drag.lastY
    if (Math.abs(dxPx) < 0.5 && Math.abs(dyPx) < 0.5) return
    drag.lastX = x
    drag.lastY = y

    if (drag.kind === 'pan') {
      if (Math.hypot(x - drag.startX, y - drag.startY) > 3) drag.moved = true
      setView((current) => ({ ...current, offsetX: current.offsetX + dxPx, offsetY: current.offsetY + dyPx }))
      return
    }

    // A few pixels of slop separate a click from a drag, and the undo step is
    // banked the moment the drag declares itself - never on the click. The
    // accumulated offset is applied in one go on that first step, so the slop
    // costs no distance.
    if (!drag.moved) {
      if (Math.hypot(x - drag.startX, y - drag.startY) <= 3) return
      drag.moved = true
      props.onDragStart()
      props.onDragItems(drag.ids, (x - drag.startX) / view.scale, (y - drag.startY) / view.scale, !event.altKey)
      return
    }
    // Holding alt escapes the snapping, which is what stops a snap being an
    // argument with the software.
    props.onDragItems(drag.ids, dxPx / view.scale, dyPx / view.scale, !event.altKey)
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const { x, y } = localPoint(event)
    pointersRef.current.delete(event.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null

    if (openingDragRef.current) {
      const slid = openingDragRef.current.moved
      openingDragRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      // A tap that only selected the door ends nothing: the gesture is only a
      // gesture once it has moved something.
      if (slid) props.onDragEnd()
      return
    }

    if (obstructionDragRef.current) {
      const carried = obstructionDragRef.current.moved
      const carriedId = obstructionDragRef.current.id
      obstructionDragRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      if (carried) {
        // A zero move that settles: the column is already where it was left, and
        // this is what tells the planner to work out what is now standing in it.
        // Judging that on every pointer move instead swept every desk the column
        // passed over onto the waiting list on its way across the room.
        props.onMoveObstruction?.(carriedId, 0, 0, true)
        props.onDragEnd()
      }
      return
    }

    if (rotateRef.current) {
      const turned = rotateRef.current.appliedDeg ?? 0
      rotateRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      if (turned !== 0) props.onDragEnd()
      return
    }

    if (cornerDragRef.current !== null) {
      const movedCorner = cornerMovedRef.current
      cornerMovedRef.current = false
      cornerDragRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      // Settle on release, never during: see the reducer's set-shape. And only
      // a drag that went somewhere - settling a corner that was merely clicked
      // marked the plan dirty for looking at it.
      if (movedCorner) props.onShape(props.geometry.vertices, true)
      return
    }

    const drag = dragRef.current
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!drag) return

    if (drag.moved) {
      if (drag.kind === 'items') props.onDragEnd()
      return
    }

    if (drag.kind === 'items') return

    // A tap - the pointer went down and came up without going anywhere. What it
    // means depends on the mode, and doing it HERE rather than on the way down
    // is what lets the same finger pan and pinch in every mode.

    if (props.mode === 'draw') {
      const point = snapDraw(toPlan(x, y), draft[draft.length - 1])
      const first = draft[0]
      if (first && draft.length >= 3) {
        const at = toScreen(first)
        if (Math.hypot(at.x - x, at.y - y) <= CORNER_HIT_PX) {
          props.onDrawDone(draft)
          return
        }
      }
      const previous = draft[draft.length - 1]
      if (previous) {
        const at = toScreen(previous)
        // A double-tap landing back on the last corner would otherwise close a
        // zero-length wall, which later fails validation with a message that
        // only makes sense in shape mode. "Back a corner" is the real undo here.
        if (Math.hypot(at.x - x, at.y - y) <= CORNER_HIT_PX) return
      }
      setDraft([...draft, point])
      return
    }

    if (props.mode === 'openings') {
      const point = toPlan(x, y)
      const wall = nearestWallWithin(props.geometry, point, WALL_HIT_PX * 2 / view.scale)
      if (wall) {
        const along = offsetAlongWall(props.geometry.vertices, wall.index, point)
        if (along !== null) {
          props.onDragStart()
          props.onAddOpening?.(wall.index, along)
          return
        }
      }
      props.onSelectOpening?.(null)
      return
    }

    if (props.mode === 'obstructions') {
      const point = toPlan(x, y)
      if (pointInPolygon(point, props.geometry.vertices)) {
        props.onDragStart()
        props.onAddObstruction?.(Math.round(point.x), Math.round(point.y))
        return
      }
      props.onSelectObstruction?.(null)
      return
    }

    // A click on bare floor. Next to a wall it opens that wall's length;
    // anywhere else it clears the selection. The tolerance is in screen pixels,
    // converted here - measured in millimetres it scales with the zoom, which is
    // how a click in the middle of a small room ends up "next to" every wall at
    // once.
    const wall = nearestWallWithin(props.geometry, toPlan(x, y), WALL_HIT_PX / view.scale)
    if (wall) {
      props.onWallClick(wall.index, wall.lengthMm)
      return
    }
    props.onSelect([])
  }

  return (
    <div ref={wrapRef} className="spl-plan-wrap" style={{ position: 'absolute', inset: 0 }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const point = toPlan(event.clientX - rect.left, event.clientY - rect.top)
          if (props.mode === 'shape') {
            // Split the nearest wall where it was double-clicked. This is how a
            // rectangle becomes an L: add a corner, then drag it.
            const wall = nearestWallWithin(props.geometry, point, WALL_HIT_PX * 2 / view.scale)
            if (!wall) return
            const next = [...props.geometry.vertices]
            next.splice(wall.index + 1, 0, { x: Math.round(point.x), y: Math.round(point.y) })
            props.onShape(next, true)
            setCorner(wall.index + 1)
            return
          }
          if (!props.onDropAt) return
          props.onDropAt(Math.round(point.x), Math.round(point.y))
        }}
        role="application"
        aria-label="Room plan. Every item here is also listed, with its exact position, in the panel beside it."
      />
      {props.mode === 'openings' && (
        <div className="spl-stage-bar">
          <span className="spl-note">
            {/* The article has to follow the noun: interpolating the kind
                straight in produced "put a opening in it" for one of the
                three. */}
            Tap a wall to put {props.openingKind === 'opening' ? 'an opening' : `a ${props.openingKind ?? 'door'}`} in it.
            Drag one along to move it.
          </span>
        </div>
      )}

      {props.mode === 'obstructions' && (
        <div className="spl-stage-bar">
          <span className="spl-note">Tap the floor to add a column. Drag one to move it; its size is in the bar above.</span>
        </div>
      )}

      {props.mode === 'shape' && (
        <div className="spl-stage-bar">
          <span className="spl-note">Drag a corner. Double-tap a wall to add one, or tap a wall to type its length.</span>
          <button
            type="button"
            className="spl-btn spl-btn-danger"
            disabled={corner === null || props.geometry.vertices.length <= 3}
            onClick={() => corner !== null && removeCorner(corner)}
          >
            Remove corner
          </button>
        </div>
      )}

      {props.mode === 'draw' && (
        <div className="spl-stage-bar">
          <span className="spl-note">
            {draft.length === 0
              ? 'Tap each corner of your room in turn.'
              : draft.length < 3
                ? `${draft.length} corner${draft.length === 1 ? '' : 's'} so far - keep going.`
                : 'Tap the first corner again to close the room.'}
          </span>
          <button type="button" className="spl-btn" disabled={draft.length === 0} onClick={() => setDraft(draft.slice(0, -1))}>
            Back a corner
          </button>
          <button type="button" className="spl-btn spl-btn-primary" disabled={draft.length < 3} onClick={() => props.onDrawDone(draft)}>
            Finish
          </button>
        </div>
      )}

      <div className="spl-stage-tools">
        <button
          type="button"
          className="spl-btn spl-btn-icon"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => {
            const wrap = wrapRef.current
            zoomAt(1.25, (wrap?.clientWidth ?? 0) / 2, (wrap?.clientHeight ?? 0) / 2)
          }}
        >
          +
        </button>
        <button
          type="button"
          className="spl-btn spl-btn-icon"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => {
            const wrap = wrapRef.current
            zoomAt(0.8, (wrap?.clientWidth ?? 0) / 2, (wrap?.clientHeight ?? 0) / 2)
          }}
        >
          −
        </button>
        <button type="button" className="spl-btn spl-btn-icon" title="Fit the room to the view" aria-label="Fit the room to the view" onClick={() => fit(true)}>
          ⤢
        </button>
      </div>
    </div>
  )
}

/**
 * The outline being drawn: what has been put down, the wall following the
 * pointer, and the length of it as it goes.
 *
 * The running length matters more than it looks. Somebody drawing their office
 * is translating a tape measure into clicks, and a wall that says 3.2 m while
 * they are still holding it is the difference between drawing the room and
 * drawing a shape that has to be corrected afterwards.
 */
function drawDraft(
  context: CanvasRenderingContext2D,
  draft: Vertex[],
  hover: Vertex | null,
  toScreen: (point: Vertex) => { x: number; y: number },
  style: { ink: string; accent: string; muted: string; surface: string; units: RoomGeometry['units'] },
): void {
  const points = draft.map(toScreen)

  if (points.length > 1) {
    context.beginPath()
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y)
      else context.lineTo(point.x, point.y)
    })
    context.strokeStyle = style.ink
    context.lineWidth = 3
    context.lineJoin = 'round'
    context.stroke()
  }

  // Every wall already drawn, labelled.
  for (let i = 1; i < draft.length; i++) {
    const a = draft[i - 1]
    const b = draft[i]
    if (!a || !b) continue
    labelSpan(context, toScreen(a), toScreen(b), formatLength(Math.hypot(b.x - a.x, b.y - a.y), style.units), style)
  }

  const last = draft[draft.length - 1]
  if (last && hover) {
    const from = toScreen(last)
    const to = toScreen(hover)
    context.save()
    context.setLineDash([6, 4])
    context.strokeStyle = style.accent
    context.lineWidth = 2
    drawSegment(context, from, to)
    context.restore()
    labelSpan(context, from, to, formatLength(Math.hypot(hover.x - last.x, hover.y - last.y), style.units), style)
  }

  points.forEach((point, index) => {
    const first = index === 0 && draft.length >= 3
    context.beginPath()
    context.arc(point.x, point.y, first ? 8 : 5, 0, Math.PI * 2)
    context.fillStyle = first ? style.accent : style.surface
    context.fill()
    context.lineWidth = 2
    context.strokeStyle = first ? style.accent : style.ink
    context.stroke()
  })
}

function labelSpan(
  context: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  text: string,
  style: { muted: string; surface: string },
): void {
  if (Math.hypot(to.x - from.x, to.y - from.y) < 30) return
  context.save()
  context.font = '500 12px system-ui, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const at = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 12 }
  const boxWidth = context.measureText(text).width + 10
  context.fillStyle = withAlpha(style.surface, 0.9)
  context.fillRect(at.x - boxWidth / 2, at.y - 8, boxWidth, 16)
  context.fillStyle = style.muted
  context.fillText(text, at.x, at.y)
  context.restore()
}

function drawSegment(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }): void {
  context.beginPath()
  context.moveTo(from.x, from.y)
  context.lineTo(to.x, to.y)
  context.stroke()
}

/** The middle of an opening, in plan coordinates - what you grab to slide it. */
function openingCentre(geometry: RoomGeometry, opening: WallOpening): Vertex | null {
  const span = openingSpan(geometry, opening)
  if (!span) return null
  return { x: (span.start.x + span.end.x) / 2, y: (span.start.y + span.end.y) / 2 }
}

/**
 * Where the turn handle floats: off the item's front edge, a fixed number of
 * screen pixels clear of it.
 *
 * Fixed in PIXELS rather than in millimetres, so it is the same easy target on a
 * pedestal as on a boardroom table - a handle sized in room units is either
 * inside the furniture or halfway across the office.
 */
export function rotateHandlePoint(item: Pick<PlanItem, 'x' | 'y' | 'yaw' | 'depthMm'>, scale: number): Vertex {
  const reach = item.depthMm / 2 + ROTATE_HANDLE_PX / Math.max(scale, 1e-6)
  const offset = rotatePoint(0, reach, item.yaw)
  return { x: item.x + offset.x, y: item.y + offset.y }
}

/**
 * The turn handle itself.
 *
 * Direct manipulation, because rotation was reachable only from the properties
 * panel and from a keyboard shortcut nobody was ever told about - and an item
 * you can drag but cannot turn reads as an item that does not turn.
 */
function drawRotateHandle(
  context: CanvasRenderingContext2D,
  item: PlanItem,
  scale: number,
  toScreen: (point: Vertex) => { x: number; y: number },
  style: { accent: string; surface: string },
): void {
  const handle = toScreen(rotateHandlePoint(item, scale))
  const corners = itemCorners(item)
  const a = corners[3]
  const b = corners[2]
  if (!a || !b) return
  const front = toScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

  context.save()
  context.strokeStyle = style.accent
  context.lineWidth = 1.5
  context.setLineDash([3, 3])
  drawSegment(context, front, handle)
  context.setLineDash([])

  context.beginPath()
  context.arc(handle.x, handle.y, 7, 0, Math.PI * 2)
  context.fillStyle = style.surface
  context.fill()
  context.lineWidth = 2
  context.stroke()

  // A three-quarter ring inside it, so the handle reads as "turn" rather than as
  // one more corner to drag.
  context.beginPath()
  context.arc(handle.x, handle.y, 3.5, 0.6, Math.PI * 1.7)
  context.lineWidth = 1.5
  context.stroke()
  context.restore()
}

/** A small notch on the item's front edge, so a desk turned round looks turned round. */
function drawFacingMark(
  context: CanvasRenderingContext2D,
  item: PlanItem,
  toScreen: (point: Vertex) => { x: number; y: number },
  colour: string,
): void {
  const corners = itemCorners(item)
  const a = corners[3]
  const b = corners[2]
  if (!a || !b) return
  const from = toScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const centre = toScreen({ x: item.x, y: item.y })
  const dx = from.x - centre.x
  const dy = from.y - centre.y
  const length = Math.hypot(dx, dy)
  if (length < 12) return
  context.save()
  context.strokeStyle = colour
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(centre.x + (dx / length) * (length - 8), centre.y + (dy / length) * (length - 8))
  context.lineTo(from.x, from.y)
  context.stroke()
  context.restore()
}

type ClearanceStyle = {
  accent: string
  muted: string
  danger: string
  surface: string
  warnBelowMm: number
  units: RoomGeometry['units']
}

/**
 * The gap between the selected item and the room, in millimetres, on both axes.
 *
 * Guidance, never a block: it goes amber under the configured walkway width and
 * says nothing at all about whether that is legal, because it is not a workplace
 * assessment and must never be mistaken for one.
 */
function drawClearances(
  context: CanvasRenderingContext2D,
  item: PlanItem,
  geometry: RoomGeometry,
  toScreen: (point: Vertex) => { x: number; y: number },
  style: ClearanceStyle,
): void {
  const corners = itemCorners(item)

  // One gap per face, cast straight out from the middle of that face to
  // whichever wall it actually reaches.
  //
  // This used to measure to the room's BOUNDING BOX along the screen axes, which
  // is wrong twice over: in an L-shaped room the box includes the corner that
  // was cut out, so the figure was the distance to a wall that is not there; and
  // a turned desk was measured across its own diagonal. Neither is a number
  // anybody should be arranging an office by.
  const gaps: Array<{ from: Vertex; to: Vertex; mm: number }> = []
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % corners.length]
    if (!a || !b) continue
    const from = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    // Straight out of the item: for a rectangle, away from its own centre.
    const outX = from.x - item.x
    const outY = from.y - item.y
    const reach = distanceToWallAlong(from, outX, outY, geometry.vertices)
    if (reach === null) continue
    const scale = Math.hypot(outX, outY) || 1
    gaps.push({
      from,
      to: { x: from.x + (outX / scale) * reach, y: from.y + (outY / scale) * reach },
      mm: reach,
    })
  }

  context.save()
  context.font = '500 11px system-ui, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  for (const gap of gaps) {
    if (gap.mm < 30) continue
    const from = toScreen(gap.from)
    const to = toScreen(gap.to)
    if (Math.hypot(to.x - from.x, to.y - from.y) < 26) continue
    const tight = style.warnBelowMm > 0 && gap.mm < style.warnBelowMm
    context.strokeStyle = tight ? style.danger : style.accent
    context.setLineDash([4, 3])
    context.lineWidth = 1
    drawSegment(context, from, to)
    context.setLineDash([])

    const text = formatLength(Math.round(gap.mm), style.units)
    const at = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
    const boxWidth = context.measureText(text).width + 8
    context.fillStyle = withAlpha(style.surface, 0.9)
    context.fillRect(at.x - boxWidth / 2, at.y - 8, boxWidth, 16)
    context.fillStyle = tight ? style.danger : style.muted
    context.fillText(text, at.x, at.y)
  }
  context.restore()
}

function ellipsise(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (context.measureText(text).width <= maxWidth) return text
  let cut = text.length
  while (cut > 1 && context.measureText(`${text.slice(0, cut)}…`).width > maxWidth) cut -= 1
  return `${text.slice(0, cut)}…`
}

/** A unit vector, in screen space, pointing from a wall into the room. */
function inwardNormal(vertices: Vertex[], a: Vertex, b: Vertex, mid: Vertex): { x: number; y: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  const nx = -dy / length
  const ny = dx / length
  const step = Math.max(20, length * 0.02)
  const inside = pointInPolygon({ x: mid.x + nx * step, y: mid.y + ny * step }, vertices)
  return inside ? { x: nx, y: ny } : { x: -nx, y: -ny }
}

function pointInCorners(point: Vertex, corners: Vertex[]): boolean {
  let inside = false
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const a = corners[i]
    const b = corners[j]
    if (!a || !b) continue
    const hits = a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-6) + a.x
    if (hits) inside = !inside
  }
  return inside
}

function nearestWallWithin(geometry: RoomGeometry, point: Vertex, toleranceMm: number): { index: number; lengthMm: number } | null {
  let best: { index: number; lengthMm: number; distance: number } | null = null
  for (const wall of walls(geometry.vertices)) {
    const dx = wall.b.x - wall.a.x
    const dy = wall.b.y - wall.a.y
    const lengthSq = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((point.x - wall.a.x) * dx + (point.y - wall.a.y) * dy) / lengthSq))
    const distance = Math.hypot(point.x - (wall.a.x + t * dx), point.y - (wall.a.y + t * dy))
    if (!best || distance < best.distance) best = { index: wall.index, lengthMm: wall.lengthMm, distance }
  }
  return best && best.distance <= toleranceMm ? { index: best.index, lengthMm: best.lengthMm } : null
}

/** Tokens can be hex or a colour function; this only ever adds transparency to whatever came out. */
function withAlpha(colour: string, alpha: number): string {
  if (colour.startsWith('#') && (colour.length === 7 || colour.length === 4)) {
    const full = colour.length === 4 ? `#${colour[1]}${colour[1]}${colour[2]}${colour[2]}${colour[3]}${colour[3]}` : colour
    const r = parseInt(full.slice(1, 3), 16)
    const g = parseInt(full.slice(3, 5), 16)
    const b = parseInt(full.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return colour
}
