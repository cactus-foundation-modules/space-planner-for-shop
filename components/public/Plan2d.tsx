'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { boundingBox, itemCorners, openingSpan, pointInPolygon, walls } from '@/modules/space-planner-for-shop/lib/geometry'
import { formatLength } from '@/modules/space-planner-for-shop/lib/units'
import type { PlanItem, RoomGeometry, Vertex } from '@/modules/space-planner-for-shop/lib/types'

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

export type Plan2dProps = {
  geometry: RoomGeometry
  items: PlanItem[]
  selection: string[]
  labels: Record<string, string>
  clashes: Array<{ a: string; b: string }>
  /** Millimetres. Zero switches the clearance guides off. */
  walkwayClearanceMm: number
  onSelect: (ids: string[]) => void
  onDragItems: (ids: string[], dx: number, dy: number, snap: boolean) => void
  onDragEnd: () => void
  onWallClick: (wallIndex: number, currentLengthMm: number) => void
  onDropAt?: (x: number, y: number) => void
}

type View = { scale: number; offsetX: number; offsetY: number }

const PADDING = 44
/** How near a wall a click has to land, in screen pixels, to mean "edit this wall". */
const WALL_HIT_PX = 18
const MIN_ZOOM = 0.25
const MAX_ZOOM = 6

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

      const box = boundingBox(props.geometry.vertices)
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
    [props.geometry],
  )

  useEffect(() => {
    fit(false)
  }, [fit])

  useEffect(() => {
    const observer = new ResizeObserver(() => fit(false))
    if (wrapRef.current) observer.observe(wrapRef.current)
    return () => observer.disconnect()
    // Deliberately not keyed on `fit`: the observer only has to exist, and
    // re-subscribing on every geometry change costs a disconnect per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [])

  const toScreen = useCallback((point: Vertex) => ({ x: point.x * view.scale + view.offsetX, y: point.y * view.scale + view.offsetY }), [view])
  const toPlan = useCallback((x: number, y: number) => ({ x: (x - view.offsetX) / view.scale, y: (y - view.offsetY) / view.scale }), [view])

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
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const width = canvas.width / ratio
    const height = canvas.height / ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)

    const style = getComputedStyle(canvas)
    const ink = style.getPropertyValue('--color-text').trim() || '#111'
    // Derived from the ink rather than read from --color-text-muted: the muted
    // token is a decorative grey that measures about 2.4:1 on this theme's
    // background, and dimension figures on a plan are the last text on the site
    // that should be hard to read. Fading the real text colour keeps it
    // theme-following and lands well inside AA in light and dark.
    const muted = withAlpha(ink, 0.72)
    const line = style.getPropertyValue('--color-border').trim() || '#ccc'
    const accent = style.getPropertyValue('--color-primary').trim() || '#2f6fed'
    const surface = style.getPropertyValue('--color-bg').trim() || '#fff'
    const danger = style.getPropertyValue('--color-danger').trim() || '#b3261e'

    // Floor
    context.beginPath()
    props.geometry.vertices.forEach((vertex, index) => {
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
    const box = boundingBox(props.geometry.vertices)
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
      const at = { x: mid.x + inward.x * 16, y: mid.y + inward.y * 16 }
      const boxWidth = context.measureText(text).width + 10
      context.fillStyle = withAlpha(surface, 0.85)
      context.fillRect(at.x - boxWidth / 2, at.y - 8, boxWidth, 16)
      context.fillStyle = muted
      context.fillText(text, at.x, at.y)
      context.restore()
    }

    // Obstructions
    context.setLineDash([6, 4])
    context.lineWidth = 1.5
    context.strokeStyle = muted
    for (const obstruction of props.geometry.obstructions) {
      context.beginPath()
      obstruction.vertices.forEach((vertex, index) => {
        const point = toScreen(vertex)
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      })
      context.closePath()
      context.stroke()
    }
    context.setLineDash([])

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
      context.stroke()

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
          context.fillText(`${Math.round(item.widthMm)} × ${Math.round(item.depthMm)}`, centre.x, centre.y + 7)
        }
        context.restore()
      }
    }

    // What the selected thing has around it, in numbers. A gap you can see is a
    // guess; a gap with 780 written on it is a decision.
    const onlySelected = props.selection.length === 1 ? props.items.find((item) => item.id === props.selection[0]) : null
    if (onlySelected && !onlySelected.staged) {
      drawClearances(context, onlySelected, props.geometry, toScreen, {
        accent,
        muted,
        danger,
        surface,
        warnBelowMm: props.walkwayClearanceMm,
        units: props.geometry.units,
      })
    }
  }, [props.geometry, props.items, props.selection, props.labels, props.clashes, props.walkwayClearanceMm, view, toScreen])

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

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const { x, y } = localPoint(event)
    pointersRef.current.set(event.pointerId, { x, y })
    if (pointersRef.current.size === 2) {
      // Second finger down: this is a pinch, not a drag. Whatever the first
      // finger had started is abandoned rather than fought with.
      const [a, b] = [...pointersRef.current.values()]
      if (a && b) pinchRef.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoomRef.current }
      dragRef.current = null
      return
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
      dragRef.current = { kind: 'items', ids, startX: x, startY: y, lastX: x, lastY: y, moved: false }
    } else {
      dragRef.current = { kind: 'pan', ids: [], startX: x, startY: y, lastX: x, lastY: y, moved: false }
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const { x, y } = localPoint(event)
    if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, { x, y })

    const pinch = pinchRef.current
    if (pinch && pointersRef.current.size === 2) {
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
    if (Math.hypot(x - drag.startX, y - drag.startY) > 3) drag.moved = true

    if (drag.kind === 'pan') {
      setView((current) => ({ ...current, offsetX: current.offsetX + dxPx, offsetY: current.offsetY + dyPx }))
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
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top)
        }}
        onDoubleClick={(event) => {
          if (!props.onDropAt) return
          const rect = event.currentTarget.getBoundingClientRect()
          const point = toPlan(event.clientX - rect.left, event.clientY - rect.top)
          props.onDropAt(Math.round(point.x), Math.round(point.y))
        }}
        role="application"
        aria-label="Room plan. Every item here is also listed, with its exact position, in the panel beside it."
      />
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

function drawSegment(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }): void {
  context.beginPath()
  context.moveTo(from.x, from.y)
  context.lineTo(to.x, to.y)
  context.stroke()
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
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  const room = boundingBox(geometry.vertices)
  const gaps: Array<{ from: Vertex; to: Vertex; mm: number }> = [
    { from: { x: room.minX, y: item.y }, to: { x: Math.min(...xs), y: item.y }, mm: Math.min(...xs) - room.minX },
    { from: { x: Math.max(...xs), y: item.y }, to: { x: room.maxX, y: item.y }, mm: room.maxX - Math.max(...xs) },
    { from: { x: item.x, y: room.minY }, to: { x: item.x, y: Math.min(...ys) }, mm: Math.min(...ys) - room.minY },
    { from: { x: item.x, y: Math.max(...ys) }, to: { x: item.x, y: room.maxY }, mm: room.maxY - Math.max(...ys) },
  ]

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
