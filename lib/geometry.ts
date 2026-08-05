import type { OpeningKind, PlanItem, RoomGeometry, Vertex, WallOpening } from '@/modules/space-planner-for-shop/lib/types'

// Pure floor-plan maths. No three.js, no DOM, no database - the 2D editor, the
// 3D scene, the server-side validator and the render worker all reach for the
// same functions here, and a rule that lives in only one of those four is a rule
// that has already gone wrong somewhere.
//
// There is deliberately no constraint solver. A solver is a tar pit, and a
// planner where dragging one wall silently rearranges three others is a planner
// nobody trusts. The model is the simple one: what you moved is what moved.

export type Wall = {
  index: number
  a: Vertex
  b: Vertex
  lengthMm: number
  /** Degrees, measured the same way item yaw is. */
  angleDeg: number
  /** Unit vector pointing into the room from this wall. */
  inwardX: number
  inwardY: number
}

const EPSILON = 1e-6

export function distance(a: Vertex, b: Vertex): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

const ORIGIN: Vertex = { x: 0, y: 0 }

/**
 * A vertex by index, wrapping round the loop.
 *
 * Every function here walks a closed polygon, which means an index that runs off
 * the end and comes back at the start. Doing the modulo at each of the twenty
 * call sites was both noisy and, under strict index checking, a pile of
 * assertions. One helper does the wrap and answers the empty-polygon case once:
 * callers all guard on length first, so the fallback is unreachable rather than
 * load-bearing.
 */
function at(vertices: Vertex[], index: number): Vertex {
  const n = vertices.length
  if (n === 0) return ORIGIN
  return vertices[((index % n) + n) % n] ?? ORIGIN
}

/**
 * Twice the signed area. Positive is the winding this module treats as canonical.
 * (Screen y runs down, so "canonical" looks clockwise on the plan - the sign is
 * only ever compared with itself, never shown to anybody.)
 */
export function polygonSignedArea(vertices: Vertex[]): number {
  let sum = 0
  for (let i = 0; i < vertices.length; i++) {
    const a = at(vertices, i)
    const b = at(vertices, i + 1)
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/** Floor area in square metres, which is the number people actually want. */
export function polygonAreaM2(vertices: Vertex[]): number {
  return Math.abs(polygonSignedArea(vertices)) / 1_000_000
}

export function perimeterMm(vertices: Vertex[]): number {
  let total = 0
  for (let i = 0; i < vertices.length; i++) {
    total += distance(at(vertices, i), at(vertices, i + 1))
  }
  return total
}

/** Flips the loop when it was drawn the other way round, rather than refusing it. */
export function normaliseWinding(vertices: Vertex[]): Vertex[] {
  return polygonSignedArea(vertices) < 0 ? [...vertices].reverse() : [...vertices]
}

export function boundingBox(vertices: Vertex[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (vertices.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const v of vertices) {
    if (v.x < minX) minX = v.x
    if (v.y < minY) minY = v.y
    if (v.x > maxX) maxX = v.x
    if (v.y > maxY) maxY = v.y
  }
  return { minX, minY, maxX, maxY }
}

export function walls(vertices: Vertex[]): Wall[] {
  const out: Wall[] = []
  const canonical = polygonSignedArea(vertices) >= 0
  for (let i = 0; i < vertices.length; i++) {
    const a = at(vertices, i)
    const b = at(vertices, i + 1)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    // The inward normal is the wall direction turned a quarter turn; which of
    // the two quarter turns depends on the winding, which is why it is checked
    // rather than assumed. Get this backwards and every wall-snapped desk ends
    // up outside the building, which is a very obvious bug that is nonetheless
    // easy to write.
    const nx = len > EPSILON ? (canonical ? -dy / len : dy / len) : 0
    const ny = len > EPSILON ? (canonical ? dx / len : -dx / len) : 0
    out.push({
      index: i,
      a,
      b,
      lengthMm: len,
      angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
      inwardX: nx,
      inwardY: ny,
    })
  }
  return out
}

/**
 * Change one wall's length by sliding everything downstream of it.
 *
 * This is the interaction the whole room editor hangs off, because people know
 * lengths and cannot draw to scale. The wall's start vertex is the anchor; every
 * other vertex slides by the same delta. So the wall changes as asked, every
 * other wall keeps its length and its direction, and the single wall that ends
 * at the anchor takes up the slack.
 *
 * That last part is the whole design. One wall visibly absorbing the change is a
 * thing a person can see, predict and undo. A solver quietly rearranging four
 * walls to keep everything square is a thing they argue with.
 */
export function setWallLength(vertices: Vertex[], wallIndex: number, newLengthMm: number): Vertex[] {
  const n = vertices.length
  if (n < 3 || wallIndex < 0 || wallIndex >= n) return vertices
  const a = at(vertices, wallIndex)
  const b = at(vertices, wallIndex + 1)
  const current = distance(a, b)
  if (current < EPSILON) return vertices

  const ux = (b.x - a.x) / current
  const uy = (b.y - a.y) / current
  const delta = newLengthMm - current
  const dx = ux * delta
  const dy = uy * delta

  // Every vertex from the far end of this wall up to (not including) its start.
  const moved = new Set<number>()
  for (let step = 1; step < n; step++) moved.add((wallIndex + step) % n)

  return vertices.map((v, i) => (moved.has(i) ? { x: v.x + dx, y: v.y + dy } : v))
}

/** Translate so the bounding box starts at the origin, and round to whole millimetres. */
export function normaliseOrigin(vertices: Vertex[]): Vertex[] {
  const { minX, minY } = boundingBox(vertices)
  return vertices.map((v) => ({ x: Math.round(v.x - minX), y: Math.round(v.y - minY) }))
}

export function pointInPolygon(point: Vertex, vertices: Vertex[]): boolean {
  let inside = false
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const vi = at(vertices, i)
    const vj = at(vertices, j)
    const intersects =
      vi.y > point.y !== vj.y > point.y &&
      point.x < ((vj.x - vi.x) * (point.y - vi.y)) / (vj.y - vi.y || EPSILON) + vi.x
    if (intersects) inside = !inside
  }
  return inside
}

function orientation(p: Vertex, q: Vertex, r: Vertex): number {
  const value = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
  if (Math.abs(value) < EPSILON) return 0
  return value > 0 ? 1 : 2
}

function onSegment(p: Vertex, q: Vertex, r: Vertex): boolean {
  return (
    q.x <= Math.max(p.x, r.x) + EPSILON &&
    q.x >= Math.min(p.x, r.x) - EPSILON &&
    q.y <= Math.max(p.y, r.y) + EPSILON &&
    q.y >= Math.min(p.y, r.y) - EPSILON
  )
}

export function segmentsIntersect(p1: Vertex, q1: Vertex, p2: Vertex, q2: Vertex): boolean {
  const o1 = orientation(p1, q1, p2)
  const o2 = orientation(p1, q1, q2)
  const o3 = orientation(p2, q2, p1)
  const o4 = orientation(p2, q2, q1)
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && onSegment(p1, p2, q1)) return true
  if (o2 === 0 && onSegment(p1, q2, q1)) return true
  if (o3 === 0 && onSegment(p2, p1, q2)) return true
  if (o4 === 0 && onSegment(p2, q1, q2)) return true
  return false
}

/**
 * A figure-of-eight room is not a room. Adjacent walls share a vertex and are
 * skipped; anything else crossing means the outline folds through itself, and
 * every downstream thing - triangulation, inside/outside tests, wall extrusion -
 * produces nonsense from it.
 */
export function isSelfIntersecting(vertices: Vertex[]): boolean {
  const n = vertices.length
  if (n < 4) return false
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (i === j) continue
      const adjacent = j === i + 1 || (i === 0 && j === n - 1)
      if (adjacent) continue
      if (segmentsIntersect(at(vertices, i), at(vertices, i + 1), at(vertices, j), at(vertices, j + 1))) {
        return true
      }
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type GeometryIssue = {
  code: 'too-few-walls' | 'self-intersecting' | 'wall-too-short' | 'opening-too-wide' | 'opening-off-wall' | 'ceiling-out-of-range' | 'obstruction-outside' | 'room-too-large'
  message: string
  wallIndex?: number
  openingId?: string
  obstructionId?: string
}

export const MIN_WALL_MM = 100
export const MAX_ROOM_SPAN_MM = 200_000
export const MIN_CEILING_MM = 1500
export const MAX_CEILING_MM = 20_000

/**
 * Everything the editor refuses gently and the server refuses flatly. Returning a
 * list rather than throwing on the first problem matters: somebody who has drawn
 * an awkward room wants to be told about all three mistakes at once, not led
 * through them one reload at a time.
 */
export function validateRoomGeometry(geometry: RoomGeometry): GeometryIssue[] {
  const issues: GeometryIssue[] = []
  const vertices = geometry.vertices

  if (vertices.length < 3) {
    issues.push({ code: 'too-few-walls', message: 'A room needs at least three walls.' })
    return issues
  }

  if (isSelfIntersecting(vertices)) {
    issues.push({ code: 'self-intersecting', message: 'The walls cross over each other. Move a corner so the outline does not fold through itself.' })
  }

  const wallList = walls(vertices)
  for (const wall of wallList) {
    if (wall.lengthMm < MIN_WALL_MM) {
      issues.push({ code: 'wall-too-short', wallIndex: wall.index, message: `Wall ${wall.index + 1} is under ${MIN_WALL_MM} mm long. Drag its corner or delete it.` })
    }
  }

  const box = boundingBox(vertices)
  if (box.maxX - box.minX > MAX_ROOM_SPAN_MM || box.maxY - box.minY > MAX_ROOM_SPAN_MM) {
    issues.push({ code: 'room-too-large', message: 'That room is over 200 m across. Plan it in sections.' })
  }

  if (geometry.ceilingMm < MIN_CEILING_MM || geometry.ceilingMm > MAX_CEILING_MM) {
    issues.push({ code: 'ceiling-out-of-range', message: 'The ceiling height needs to be between 1.5 m and 20 m.' })
  }

  for (const opening of geometry.openings) {
    const wall = wallList[opening.wallIndex]
    if (!wall) {
      issues.push({ code: 'opening-off-wall', openingId: opening.id, message: 'A door or window is attached to a wall that no longer exists.' })
      continue
    }
    if (opening.offsetMm < 0 || opening.offsetMm + opening.widthMm > wall.lengthMm + 1) {
      issues.push({ code: 'opening-too-wide', openingId: opening.id, wallIndex: opening.wallIndex, message: `A ${opening.kind} does not fit on wall ${opening.wallIndex + 1}.` })
    }
    if (opening.sillMm + opening.heightMm > geometry.ceilingMm) {
      issues.push({ code: 'opening-too-wide', openingId: opening.id, wallIndex: opening.wallIndex, message: `A ${opening.kind} on wall ${opening.wallIndex + 1} is taller than the ceiling.` })
    }
  }

  for (const obstruction of geometry.obstructions) {
    const outside = obstruction.vertices.some((v) => !pointInPolygon(v, vertices))
    if (outside) {
      issues.push({ code: 'obstruction-outside', obstructionId: obstruction.id, message: `"${obstruction.label || 'An obstruction'}" sticks out of the room.` })
    }
  }

  return issues
}

/**
 * How far along a wall a point falls, in millimetres from that wall's start.
 *
 * Clamped to the wall, so a pointer that has wandered off the end of it gives
 * the end rather than a number off the wall entirely - which is what somebody
 * dragging a door towards a corner means.
 */
export function offsetAlongWall(vertices: Vertex[], wallIndex: number, point: Vertex): number | null {
  const wall = walls(vertices)[wallIndex]
  if (!wall || wall.lengthMm < EPSILON) return null
  const dx = wall.b.x - wall.a.x
  const dy = wall.b.y - wall.a.y
  const t = ((point.x - wall.a.x) * dx + (point.y - wall.a.y) * dy) / (dx * dx + dy * dy)
  return Math.max(0, Math.min(1, t)) * wall.lengthMm
}

/**
 * An opening put back where it fits.
 *
 * Doors and windows are held as a distance along a wall, so anything that
 * changes the wall - typing a length, dragging a corner - can leave one hanging
 * off the end of it. Everything that writes an opening comes through here, and
 * null means the wall is too short to hold it at all.
 */
export function fitOpeningToWall(geometry: RoomGeometry, opening: WallOpening): WallOpening | null {
  const wall = walls(geometry.vertices)[opening.wallIndex]
  if (!wall) return null
  const widthMm = Math.max(MIN_OPENING_MM, Math.min(opening.widthMm, wall.lengthMm))
  if (wall.lengthMm < MIN_OPENING_MM) return null
  const heightMm = Math.max(MIN_OPENING_MM, Math.min(opening.heightMm, geometry.ceilingMm - opening.sillMm))
  return {
    ...opening,
    widthMm,
    heightMm,
    offsetMm: Math.round(Math.max(0, Math.min(opening.offsetMm, wall.lengthMm - widthMm))),
    sillMm: Math.max(0, Math.min(opening.sillMm, Math.max(0, geometry.ceilingMm - MIN_OPENING_MM))),
  }
}

/** Nothing narrower or shorter than this is a door, a window or anything else. */
export const MIN_OPENING_MM = 100

/** What a new one starts as. Ordinary UK sizes, so most need no adjusting at all. */
export const OPENING_DEFAULTS: Record<OpeningKind, { widthMm: number; heightMm: number; sillMm: number }> = {
  door: { widthMm: 900, heightMm: 2040, sillMm: 0 },
  window: { widthMm: 1200, heightMm: 1200, sillMm: 900 },
  opening: { widthMm: 1000, heightMm: 2100, sillMm: 0 },
}

/** Where an opening sits in plan coordinates, for drawing and for cutting the wall. */
export function openingSpan(geometry: RoomGeometry, opening: WallOpening): { start: Vertex; end: Vertex } | null {
  const wall = walls(geometry.vertices)[opening.wallIndex]
  if (!wall || wall.lengthMm < EPSILON) return null
  const ux = (wall.b.x - wall.a.x) / wall.lengthMm
  const uy = (wall.b.y - wall.a.y) / wall.lengthMm
  return {
    start: { x: wall.a.x + ux * opening.offsetMm, y: wall.a.y + uy * opening.offsetMm },
    end: { x: wall.a.x + ux * (opening.offsetMm + opening.widthMm), y: wall.a.y + uy * (opening.offsetMm + opening.widthMm) },
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function rotatePoint(x: number, y: number, degrees: number): Vertex {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return { x: x * cos - y * sin, y: x * sin + y * cos }
}

/** The four corners of an item's footprint, rotated into plan coordinates. */
export function itemCorners(item: Pick<PlanItem, 'x' | 'y' | 'yaw' | 'widthMm' | 'depthMm'>): Vertex[] {
  const hw = item.widthMm / 2
  const hd = item.depthMm / 2
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ].map((corner) => {
    const rotated = rotatePoint(corner.x, corner.y, item.yaw)
    return { x: item.x + rotated.x, y: item.y + rotated.y }
  })
}

function projectOntoAxis(points: Vertex[], axis: Vertex): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const p of points) {
    const value = p.x * axis.x + p.y * axis.y
    if (value < min) min = value
    if (value > max) max = value
  }
  return { min, max }
}

/** Separating-axis test on two rotated rectangles. */
export function footprintsOverlap(
  a: Pick<PlanItem, 'x' | 'y' | 'yaw' | 'widthMm' | 'depthMm'>,
  b: Pick<PlanItem, 'x' | 'y' | 'yaw' | 'widthMm' | 'depthMm'>,
  toleranceMm = 0,
): boolean {
  const cornersA = itemCorners(a)
  const cornersB = itemCorners(b)
  const axes: Vertex[] = []
  for (const corners of [cornersA, cornersB]) {
    for (let i = 0; i < 2; i++) {
      const p = at(corners, i)
      const q = at(corners, i + 1)
      const dx = q.x - p.x
      const dy = q.y - p.y
      const len = Math.hypot(dx, dy) || 1
      axes.push({ x: -dy / len, y: dx / len })
    }
  }
  for (const axis of axes) {
    const pa = projectOntoAxis(cornersA, axis)
    const pb = projectOntoAxis(cornersB, axis)
    if (pa.max - toleranceMm <= pb.min || pb.max - toleranceMm <= pa.min) return false
  }
  return true
}

/**
 * Whether two items actually fight, rather than merely sharing floor space.
 *
 * Naive collision blocking is wrong for office planning, where legitimate
 * overlaps are the norm: a chair tucks under a desk, a pedestal slides under the
 * desktop. Footprints crossing is only a clash when the height bands cross too.
 */
export function heightBandsClash(a: PlanItem, b: PlanItem, toleranceMm = 0): boolean {
  const aTop = a.z + a.heightMm
  const bTop = b.z + b.heightMm
  return a.z + toleranceMm < bTop && b.z + toleranceMm < aTop
}

export function itemsClash(a: PlanItem, b: PlanItem, toleranceMm = 10): boolean {
  if (a.id === b.id) return false
  if (a.parentId === b.id || b.parentId === a.id) return false
  if (!footprintsOverlap(a, b, toleranceMm)) return false
  return heightBandsClash(a, b, toleranceMm)
}

/** What the catalogue knows about the space under a product's top, per product. */
export type UnderTopSizes = Record<string, { heightMm: number | null; widthMm: number | null } | undefined>

/** A worktop is this tall, give or take. Below it is a shelf; above it is a cupboard. */
const WORKTOP_MIN_MM = 600
const WORKTOP_MAX_MM = 1100
/** And this wide, at least. Narrower than this and nothing is going under it. */
const WORKTOP_MIN_WIDTH_MM = 800
/**
 * And this deep. A desk in this catalogue is 600 to 800 deep and a boardroom
 * table more; a cupboard, a credenza or a bookcase of the same height and width
 * is 400 to 500, and is solid to the floor. Depth is the only thing in the row
 * that tells those two apart when nobody has published a clearance.
 */
const WORKTOP_MIN_DEPTH_MM = 550
/** Allowance for the thickness of the top itself when nobody has published one. */
const WORKTOP_THICKNESS_MM = 40
/**
 * Taller than this and it is not tucked under anything, it is standing in the
 * way. The tallest seating in this catalogue is a 1320 mm bench-desk cable
 * spine; a storage tower starts around 1800.
 */
const MAX_TUCKED_HEIGHT_MM = 1500

/**
 * Whether this item is the sort of thing other things go underneath.
 *
 * Answered from the catalogue where the catalogue has an answer - "Height Under
 * Top" is published on desks and worktops and on nothing else, which makes its
 * mere presence the statement. Where it is missing, the shape stands in for it:
 * desk-height, desk-width, and a top thick enough to take off the clearance.
 */
export function spaceUnderneathMm(item: PlanItem, underTop: UnderTopSizes = {}): number | null {
  const published = underTop[item.productId]?.heightMm
  if (published && published > 0) return published
  if (item.heightMm < WORKTOP_MIN_MM || item.heightMm > WORKTOP_MAX_MM) return null
  if (item.widthMm < WORKTOP_MIN_WIDTH_MM) return null
  if (item.depthMm < WORKTOP_MIN_DEPTH_MM) return null
  return item.heightMm - WORKTOP_THICKNESS_MM
}

/**
 * Whether the first item is tucked under the second rather than fighting it.
 *
 * This is the difference between a planner people trust and one they stop
 * reading. A chair pushed under a desk overlaps it in plan AND in height - the
 * backrest stands well above the worktop - so the height-band test calls it a
 * collision and paints both of them red, which is exactly the arrangement the
 * shopper was aiming for. Two desks in the same square metre have to stay red,
 * though, so what separates them is whether the thing would actually GO under.
 *
 * NOT by comparing depths, which is what this used to do and what made the
 * warning fire on the commonest arrangement in the catalogue: office chairs are
 * 640 to 690 deep and half these desks are 600, so every chair pushed under a
 * 60 cm desk came up red. A chair sticking out past the front edge of a desk is
 * what tucking one under a desk LOOKS like. What actually rules the pair out is
 * the parent having no space beneath it at all (handled by spaceUnderneathMm,
 * which now wants desk depth as well as desk height and width - a credenza is
 * the same height and width as a desk and solid to the floor), the child being
 * a worktop in its own right (two desks, a desk and a sideboard), the child
 * being too tall to be going under anything, and the published clearance width
 * where the catalogue states one.
 */
export function tucksUnder(child: PlanItem, parent: PlanItem, underTop: UnderTopSizes = {}): boolean {
  const clearance = spaceUnderneathMm(parent, underTop)
  if (clearance === null) return false
  // Standing on the floor of the space underneath, not hung across the top of it.
  if (child.z >= clearance) return false
  // Two things that are both the sort of thing others go under are not tucked,
  // they are in each other's way - which is the whole point of the warning.
  if (spaceUnderneathMm(child, underTop) !== null) return false
  if (child.heightMm > MAX_TUCKED_HEIGHT_MM) return false
  const clearWidth = underTop[parent.productId]?.widthMm ?? parent.widthMm - 100
  return child.widthMm <= clearWidth
}

/**
 * Whether two items genuinely fight, as against sharing floor space on purpose.
 *
 * The one the warning colours should use. `itemsClash` is the raw geometry and
 * knows nothing about furniture.
 */
export function itemsFight(a: PlanItem, b: PlanItem, underTop: UnderTopSizes = {}, toleranceMm = 10): boolean {
  if (!itemsClash(a, b, toleranceMm)) return false
  return !tucksUnder(a, b, underTop) && !tucksUnder(b, a, underTop)
}

/** True when every corner of the item's footprint is inside the room outline. */
export function itemInsideRoom(item: PlanItem, geometry: RoomGeometry): boolean {
  return itemCorners(item).every((corner) => pointInPolygon(corner, geometry.vertices))
}

/** True when the item's footprint crosses an interior obstruction. */
export function itemHitsObstruction(item: PlanItem, geometry: RoomGeometry): boolean {
  const corners = itemCorners(item)
  return geometry.obstructions.some((obstruction) => {
    if (item.z >= obstruction.heightMm) return false
    if (corners.some((c) => pointInPolygon(c, obstruction.vertices))) return true
    if (obstruction.vertices.some((v) => pointInPolygon(v, corners))) return true
    for (let i = 0; i < corners.length; i++) {
      for (let j = 0; j < obstruction.vertices.length; j++) {
        const ok = segmentsIntersect(
          at(corners, i),
          at(corners, i + 1),
          at(obstruction.vertices, j),
          at(obstruction.vertices, j + 1),
        )
        if (ok) return true
      }
    }
    return false
  })
}

/**
 * Nudge an item back inside the room instead of losing it.
 *
 * Dragging something through a wall is a thing everybody does within the first
 * minute. Clamping - move the centre back towards the room until the footprint
 * fits, and give up gracefully if it simply cannot - is the behaviour that never
 * produces an error message and never eats the item.
 */
export function clampItemIntoRoom(item: PlanItem, geometry: RoomGeometry): PlanItem {
  if (itemInsideRoom(item, geometry)) return item

  const box = boundingBox(geometry.vertices)
  const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }

  const place = (t: number): PlanItem => ({
    ...item,
    x: Math.round(item.x + (centre.x - item.x) * t),
    y: Math.round(item.y + (centre.y - item.y) * t),
  })

  // Walk towards the middle of the room in shrinking steps. Twenty iterations
  // resolves a 200 m room to under a fifth of a millimetre, which is far below
  // anything a person can see or a tape measure can find.
  let low = 0
  let high = 1
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2
    if (itemInsideRoom(place(mid), geometry)) high = mid
    else low = mid
  }

  // The search converges ON the wall, and a corner sitting exactly on the
  // outline is neither in nor out - which is how a clamp that "worked" still
  // reported the item as outside. Step a shade further in and take the first
  // position that is unambiguously inside.
  for (const bias of [0.002, 0.01, 0.05, 0.2, 1]) {
    const candidate = place(Math.min(1, high + bias))
    if (itemInsideRoom(candidate, geometry)) return candidate
  }
  return place(1)
}

/**
 * Which items a geometry edit has displaced.
 *
 * This is the rule with the most ways to quietly lose somebody's work, so it is
 * one function with one meaning, used by both the client preview and the server
 * write. Displaced items go to the plan's staging tray; they are never deleted.
 */
export function displacedItems(items: PlanItem[], geometry: RoomGeometry): PlanItem[] {
  return items.filter((item) => {
    if (item.staged) return false
    if (item.parentId) return false // moves with its parent, judged by the parent
    return !itemInsideRoom(item, geometry) || itemHitsObstruction(item, geometry)
  })
}

/**
 * How far it is to a wall, going that way.
 *
 * Cast rather than measured to a bounding box, because a bounding box is not the
 * room: in an L-shape the box includes the bit that was cut out, so the gap
 * shown beside a desk in the short leg was the distance to a wall that is not
 * there. Returns null when the ray leaves through no wall at all, which for a
 * point inside a closed outline means the numbers have gone wrong somewhere.
 */
export function distanceToWallAlong(origin: Vertex, dirX: number, dirY: number, vertices: Vertex[]): number | null {
  const length = Math.hypot(dirX, dirY)
  if (length < EPSILON) return null
  const dx = dirX / length
  const dy = dirY / length

  let nearest: number | null = null
  for (const wall of walls(vertices)) {
    const ex = wall.b.x - wall.a.x
    const ey = wall.b.y - wall.a.y
    const det = ex * dy - dx * ey
    if (Math.abs(det) < EPSILON) continue // parallel: it never crosses this one
    const ax = wall.a.x - origin.x
    const ay = wall.a.y - origin.y
    const t = (ex * ay - ax * ey) / det
    const u = (dx * ay - ax * dy) / det
    if (t < 0 || u < -EPSILON || u > 1 + EPSILON) continue
    if (nearest === null || t < nearest) nearest = t
  }
  return nearest
}

/** Shortest distance from a point to any wall, and which wall it was. */
export function nearestWall(point: Vertex, vertices: Vertex[]): { wallIndex: number; distanceMm: number } | null {
  const wallList = walls(vertices)
  let best: { wallIndex: number; distanceMm: number } | null = null
  for (const wall of wallList) {
    const dx = wall.b.x - wall.a.x
    const dy = wall.b.y - wall.a.y
    const lenSq = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((point.x - wall.a.x) * dx + (point.y - wall.a.y) * dy) / lenSq))
    const px = wall.a.x + t * dx
    const py = wall.a.y + t * dy
    const d = Math.hypot(point.x - px, point.y - py)
    if (!best || d < best.distanceMm) best = { wallIndex: wall.index, distanceMm: d }
  }
  return best
}

/**
 * Snap an item flat against the nearest wall when it is close enough.
 *
 * Escapable - the caller passes tolerance 0 when the shopper is holding the
 * override key - because a snap you cannot switch off is an argument with the
 * software rather than a help.
 */
export function snapToWall(item: PlanItem, geometry: RoomGeometry, toleranceMm = 250): PlanItem {
  if (toleranceMm <= 0) return item
  const near = nearestWall({ x: item.x, y: item.y }, geometry.vertices)
  if (!near || near.distanceMm > toleranceMm + item.depthMm / 2) return item
  const wall = walls(geometry.vertices)[near.wallIndex]
  if (!wall || wall.lengthMm < EPSILON) return item

  // Face into the room, back against the wall.
  const yaw = wall.angleDeg
  const dx = wall.b.x - wall.a.x
  const dy = wall.b.y - wall.a.y
  const lenSq = dx * dx + dy * dy || 1
  const t = Math.max(0, Math.min(1, ((item.x - wall.a.x) * dx + (item.y - wall.a.y) * dy) / lenSq))
  const footX = wall.a.x + t * dx
  const footY = wall.a.y + t * dy

  return {
    ...item,
    yaw,
    x: Math.round(footX + wall.inwardX * (item.depthMm / 2)),
    y: Math.round(footY + wall.inwardY * (item.depthMm / 2)),
  }
}

/** Rotation snapping, in whatever increment the caller wants (15° by default). */
export function snapYaw(yaw: number, stepDeg = 15): number {
  if (stepDeg <= 0) return yaw
  return Math.round(yaw / stepDeg) * stepDeg
}

// ---------------------------------------------------------------------------
// Snapping to the furniture already in the room
// ---------------------------------------------------------------------------

/**
 * How near two items have to be, in millimetres, before they click together.
 *
 * Generous on purpose. The whole job here is to make "two desks in a bank" a
 * thing somebody achieves with a mouse rather than a thing they achieve by
 * typing coordinates into the panel, and a tolerance that only works at maximum
 * zoom achieves neither.
 */
export const ITEM_SNAP_MM = 150

/** How far off square a neighbour may be and still count as square-on. */
const SQUARE_TOLERANCE_DEG = 3

type LocalBox = { minX: number; maxX: number; minY: number; maxY: number }

function normaliseDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360
}

/**
 * Another item's footprint, expressed in the subject's own frame.
 *
 * Null when the neighbour is not square-on to the subject. Two rectangles at
 * seventeen degrees to each other have no "flush" position worth guessing at,
 * and a snap that fires there moves furniture somewhere nobody asked for -
 * which is far worse than no snap at all.
 */
function neighbourBox(subject: Pick<PlanItem, 'x' | 'y' | 'yaw'>, other: Pick<PlanItem, 'x' | 'y' | 'yaw' | 'widthMm' | 'depthMm'>): LocalBox | null {
  const turn = normaliseDegrees(other.yaw - subject.yaw)
  const quarter = Math.round(turn / 90) % 4
  if (Math.abs(turn - quarter * 90) > SQUARE_TOLERANCE_DEG && Math.abs(turn - 360) > SQUARE_TOLERANCE_DEG) return null

  // A quarter or three-quarter turn swaps which way round the neighbour's own
  // width and depth read in this frame.
  const swapped = quarter === 1 || quarter === 3
  const halfX = (swapped ? other.depthMm : other.widthMm) / 2
  const halfY = (swapped ? other.widthMm : other.depthMm) / 2

  const centre = rotatePoint(other.x - subject.x, other.y - subject.y, -subject.yaw)
  return { minX: centre.x - halfX, maxX: centre.x + halfX, minY: centre.y - halfY, maxY: centre.y + halfY }
}

function gapOnAxis(aMin: number, aMax: number, bMin: number, bMax: number): number {
  if (aMax < bMin) return bMin - aMax
  if (bMax < aMin) return aMin - bMax
  return 0
}

/** Whether this item may be snapped to that one at all. */
function snappable(item: PlanItem, other: PlanItem): boolean {
  if (other.id === item.id || other.staged) return false
  if (other.parentId === item.id || item.parentId === other.id) return false
  // Things at different heights are not side by side, they are one above the
  // other: a shelf on the wall has no business clicking onto the desk below it.
  return heightBandsClash(item, other)
}

/**
 * Smallest face-to-face gap between this item and anything near it, or null when
 * there is nothing to measure against. Overlapping counts as zero.
 */
export function nearestItemGapMm(item: PlanItem, others: PlanItem[]): number | null {
  let smallest: number | null = null
  for (const other of others) {
    if (!snappable(item, other)) continue
    const box = neighbourBox(item, other)
    if (!box) continue
    const gap = Math.hypot(
      gapOnAxis(-item.widthMm / 2, item.widthMm / 2, box.minX, box.maxX),
      gapOnAxis(-item.depthMm / 2, item.depthMm / 2, box.minY, box.maxY),
    )
    if (smallest === null || gap < smallest) smallest = gap
  }
  return smallest
}

/**
 * Click an item against the furniture already in the room.
 *
 * Two desks that are meant to be a bank of two have to actually touch, and doing
 * that by mouse alone - to the millimetre, on a plan where one pixel is several
 * centimetres - is not a thing anybody can do. So each axis takes the nearest of
 * five offers from every square-on neighbour: the two that put the faces
 * together, the two that line the far edges up, and the one that lines the
 * centres up. Faces first, because "against" is what people are usually after
 * and "lined up with" is what they want at the same time on the other axis.
 *
 * A neighbour only gets a say on an axis when it is actually beside the item on
 * the other one - otherwise a desk across the room drags everything into line
 * with it, which reads as the plan having a mind of its own.
 *
 * Escapable: the caller passes tolerance 0 while the override key is held, and
 * the reducer stops offering snaps at all on a drag step that is moving away.
 */
export function snapToItems(item: PlanItem, others: PlanItem[], toleranceMm = ITEM_SNAP_MM): PlanItem {
  if (toleranceMm <= 0) return item

  const halfWidth = item.widthMm / 2
  const halfDepth = item.depthMm / 2
  // Faces beat alignments at equal distance, so they are offered first and a
  // later candidate has to be strictly nearer to displace one.
  let bestX: { delta: number; distance: number } | null = null
  let bestY: { delta: number; distance: number } | null = null

  const offer = (best: { delta: number; distance: number } | null, delta: number): { delta: number; distance: number } | null => {
    const distance = Math.abs(delta)
    if (distance > toleranceMm) return best
    return best === null || distance < best.distance ? { delta, distance } : best
  }

  for (const other of others) {
    if (!snappable(item, other)) continue
    const box = neighbourBox(item, other)
    if (!box) continue

    const gapX = gapOnAxis(-halfWidth, halfWidth, box.minX, box.maxX)
    const gapY = gapOnAxis(-halfDepth, halfDepth, box.minY, box.maxY)

    // Beside each other on the far axis, give or take the tolerance: only then
    // does lining this one up mean anything.
    if (gapY <= toleranceMm) {
      bestX = offer(bestX, box.minX - halfWidth)
      bestX = offer(bestX, box.maxX + halfWidth)
      bestX = offer(bestX, box.minX + halfWidth)
      bestX = offer(bestX, box.maxX - halfWidth)
      bestX = offer(bestX, (box.minX + box.maxX) / 2)
    }
    if (gapX <= toleranceMm) {
      bestY = offer(bestY, box.minY - halfDepth)
      bestY = offer(bestY, box.maxY + halfDepth)
      bestY = offer(bestY, box.minY + halfDepth)
      bestY = offer(bestY, box.maxY - halfDepth)
      bestY = offer(bestY, (box.minY + box.maxY) / 2)
    }
  }

  if (!bestX && !bestY) return item

  // The offers are in the item's own frame; the item's position is not.
  const world = rotatePoint(bestX?.delta ?? 0, bestY?.delta ?? 0, item.yaw)
  return { ...item, x: Math.round(item.x + world.x), y: Math.round(item.y + world.y) }
}

/**
 * Free walkway between an item and everything around it, for the clearance
 * guidance. Guidance is all it is: rules of thumb for arranging furniture, not a
 * workplace assessment, not fire-safety or means-of-escape advice, and not a
 * building-regulations check. The wording that says so travels with every place
 * this number is shown.
 */
export function clearanceAround(item: PlanItem, others: PlanItem[], geometry: RoomGeometry): number {
  const corners = itemCorners(item)
  let smallest = Infinity

  for (const corner of corners) {
    const near = nearestWall(corner, geometry.vertices)
    if (near && near.distanceMm < smallest) smallest = near.distanceMm
  }

  for (const other of others) {
    if (other.id === item.id || other.staged) continue
    if (other.parentId === item.id || item.parentId === other.id) continue
    if (!heightBandsClash(item, other)) continue
    const otherCorners = itemCorners(other)
    for (const corner of corners) {
      for (let i = 0; i < otherCorners.length; i++) {
        const a = at(otherCorners, i)
        const b = at(otherCorners, i + 1)
        const dx = b.x - a.x
        const dy = b.y - a.y
        const lenSq = dx * dx + dy * dy || 1
        const t = Math.max(0, Math.min(1, ((corner.x - a.x) * dx + (corner.y - a.y) * dy) / lenSq))
        const d = Math.hypot(corner.x - (a.x + t * dx), corner.y - (a.y + t * dy))
        if (d < smallest) smallest = d
      }
    }
  }

  return Number.isFinite(smallest) ? Math.round(smallest) : 0
}
