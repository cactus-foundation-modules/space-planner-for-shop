'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { boundingBox, itemCorners, openingSpan, walls } from '@/modules/space-planner-for-shop/lib/geometry'
import { formatLength } from '@/modules/space-planner-for-shop/lib/units'
import type { PlanItem, RoomGeometry, Vertex } from '@/modules/space-planner-for-shop/lib/types'

// The top-down plan. This is the front door and the surface everybody touches
// first, so it gets the polish budget - and it is plain 2D canvas, which means
// it keeps working on a device with no WebGL at all.
//
// Everything it can do by dragging is also reachable as a number in the
// properties panel, which is what makes the accessibility position honest rather
// than aspirational: the canvas is never the only way to accomplish anything.

export type Plan2dProps = {
  geometry: RoomGeometry
  items: PlanItem[]
  selection: string[]
  labels: Record<string, string>
  clashes: Array<{ a: string; b: string }>
  onSelect: (ids: string[]) => void
  onDragItems: (ids: string[], dx: number, dy: number, snap: boolean) => void
  onDragEnd: () => void
  onWallClick: (wallIndex: number, currentLengthMm: number) => void
  onDropAt?: (x: number, y: number) => void
}

type View = { scale: number; offsetX: number; offsetY: number }

const PADDING = 48

export function Plan2d(props: Plan2dProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<View>({ scale: 0.05, offsetX: PADDING, offsetY: PADDING })
  const dragRef = useRef<{ ids: string[]; lastX: number; lastY: number; moved: boolean } | null>(null)

  // Fit the room to the canvas. Recomputed whenever the room or the box changes,
  // because a shopper who has just typed a wall length expects to see the result
  // rather than to go looking for it.
  const fit = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const width = wrap.clientWidth
    const height = wrap.clientHeight
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.floor(width * ratio))
    canvas.height = Math.max(1, Math.floor(height * ratio))
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const box = boundingBox(props.geometry.vertices)
    const roomWidth = Math.max(1, box.maxX - box.minX)
    const roomHeight = Math.max(1, box.maxY - box.minY)
    const scale = Math.min((width - PADDING * 2) / roomWidth, (height - PADDING * 2) / roomHeight)
    setView({
      scale,
      offsetX: (width - roomWidth * scale) / 2 - box.minX * scale,
      offsetY: (height - roomHeight * scale) / 2 - box.minY * scale,
    })
  }, [props.geometry])

  useEffect(() => {
    fit()
    const observer = new ResizeObserver(() => fit())
    if (wrapRef.current) observer.observe(wrapRef.current)
    return () => observer.disconnect()
  }, [fit])

  const toScreen = useCallback((point: Vertex) => ({ x: point.x * view.scale + view.offsetX, y: point.y * view.scale + view.offsetY }), [view])
  const toPlan = useCallback((x: number, y: number) => ({ x: (x - view.offsetX) / view.scale, y: (y - view.offsetY) / view.scale }), [view])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, canvas.width, canvas.height)

    const style = getComputedStyle(canvas)
    const ink = style.getPropertyValue('--color-text').trim() || '#111'
    const muted = style.getPropertyValue('--color-text-muted').trim() || '#666'
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

      // The wall's length, clickable, because typing a number is how anybody
      // with a tape measure actually holds this information.
      const mid = toScreen({ x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 })
      context.save()
      context.fillStyle = muted
      context.font = '500 12px system-ui, sans-serif'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(formatLength(wall.lengthMm, props.geometry.units), mid.x, mid.y - 12)
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

      const label = props.labels[item.productId]
      if (label && view.scale > 0.02) {
        context.save()
        context.fillStyle = ink
        context.font = '500 11px system-ui, sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        const centre = toScreen({ x: item.x, y: item.y })
        context.fillText(label.slice(0, 18), centre.x, centre.y)
        context.restore()
      }
    }
  }, [props.geometry, props.items, props.selection, props.labels, props.clashes, view, toScreen])

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

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const hit = hitTest(x, y)

    if (!hit) {
      // Clicking bare floor near a wall is how the wall-length editor is reached.
      const point = toPlan(x, y)
      const wall = nearestWallWithin(props.geometry, point, 400 / view.scale)
      if (wall) {
        props.onWallClick(wall.index, wall.lengthMm)
        return
      }
      props.onSelect([])
      return
    }

    const ids = event.shiftKey
      ? props.selection.includes(hit.id)
        ? props.selection.filter((id) => id !== hit.id)
        : [...props.selection, hit.id]
      : props.selection.includes(hit.id)
        ? props.selection
        : [hit.id]
    props.onSelect(ids)
    dragRef.current = { ids, lastX: x, lastY: y, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    if (!drag) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const dx = (x - drag.lastX) / view.scale
    const dy = (y - drag.lastY) / view.scale
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    drag.lastX = x
    drag.lastY = y
    drag.moved = true
    // Holding alt escapes the snapping, which is what stops a snap being an
    // argument with the software.
    props.onDragItems(drag.ids, dx, dy, !event.altKey)
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag?.moved) props.onDragEnd()
  }

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => {
          if (!props.onDropAt) return
          const rect = event.currentTarget.getBoundingClientRect()
          const point = toPlan(event.clientX - rect.left, event.clientY - rect.top)
          props.onDropAt(Math.round(point.x), Math.round(point.y))
        }}
        role="application"
        aria-label="Room plan. Every item here is also listed, with its exact position, in the panel beside it."
      />
    </div>
  )
}

function drawSegment(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }): void {
  context.beginPath()
  context.moveTo(from.x, from.y)
  context.lineTo(to.x, to.y)
  context.stroke()
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
