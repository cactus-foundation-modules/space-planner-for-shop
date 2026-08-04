import {
  boundingBox,
  clampItemIntoRoom,
  footprintsOverlap,
  itemCorners,
  OPENING_DEFAULTS,
  fitOpeningToWall,
  itemInsideRoom,
  itemsFight,
  nearestItemGapMm,
  nearestWall,
  normaliseOrigin,
  normaliseWinding,
  pointInPolygon,
  rotatePoint,
  setWallLength,
  snapToItems,
  snapToWall,
  snapYaw,
} from '@/modules/space-planner-for-shop/lib/geometry'
import { PLAN_SCHEMA_VERSION } from '@/modules/space-planner-for-shop/lib/types'
import type { UnderTopSizes } from '@/modules/space-planner-for-shop/lib/geometry'
import type { MountType, OpeningKind, PlanItem, PlanItems, RoomGeometry, SizeSource, Vertex, WallOpening } from '@/modules/space-planner-for-shop/lib/types'

// The planner's state and every way it can change, as a pure reducer.
//
// Pure because undo has to work. Retrofitting undo into direct-manipulation 3D
// is misery - the moment a drag handler mutates a mesh directly, "the state" is
// spread across the scene graph and there is nothing to rewind. So the scene is
// drawn FROM this and never the other way round, and undo is a stack of
// snapshots rather than a stack of inverse operations.
//
// It is also the reason this file has tests and the canvas does not.

export type PlannerState = {
  geometry: RoomGeometry
  items: PlanItem[]
  selection: string[]
  /** Bumped on every change, so the canvas knows when to redraw without a deep compare. */
  revision: number
}

export type PlannerSnapshot = { geometry: RoomGeometry; items: PlanItem[] }

export type ProductSize = {
  productId: string
  widthMm: number
  depthMm: number
  heightMm: number
  sizeSource: SizeSource
  mount: MountType
  underTopHeightMm: number | null
  underTopWidthMm: number | null
}

export type PlannerAction =
  | { type: 'set-geometry'; geometry: RoomGeometry }
  | { type: 'set-wall-length'; wallIndex: number; lengthMm: number }
  /**
   * A new outline for the room, of any number of walls.
   *
   * `settle` separates the two halves of an edit. While a corner is under the
   * pointer the vertices are taken exactly as given: re-winding them mid-drag
   * would renumber the corner being dragged, and re-originning them would slide
   * the whole room out from under the cursor. On release, `settle` tidies the
   * winding and the origin, moves the furniture by the same amount so it stays
   * where it was in the room, and puts anything now outside the walls in the
   * tray rather than leaving it stranded in the garden.
   */
  | { type: 'set-shape'; vertices: Vertex[]; settle?: boolean }
  | { type: 'add-item'; product: ProductSize; x: number; y: number; staged?: boolean; id: string }
  | { type: 'move-items'; ids: string[]; dx: number; dy: number; snap: boolean }
  | { type: 'place-item'; id: string; x: number; y: number; snap: boolean }
  | { type: 'rotate-items'; ids: string[]; deltaDeg: number; snap: boolean }
  | { type: 'set-item'; id: string; patch: Partial<PlanItem> }
  | { type: 'delete-items'; ids: string[] }
  | { type: 'duplicate-items'; ids: string[]; offsetMm: number; newIds: string[] }
  | { type: 'array-item'; id: string; count: number; spacingMm: number; alongYaw: number; newIds: string[] }
  | { type: 'replace-product'; ids: string[]; product: ProductSize }
  | { type: 'stage-items'; ids: string[] }
  | { type: 'unstage-item'; id: string; x: number; y: number }
  | { type: 'attach'; childId: string; parentId: string | null }
  /** A door, a window or a plain gap, put on a wall at a distance along it. */
  | { type: 'add-opening'; id: string; kind: OpeningKind; wallIndex: number; offsetMm: number }
  | { type: 'set-opening'; id: string; patch: Partial<Omit<WallOpening, 'id'>> }
  | { type: 'delete-opening'; id: string }
  | { type: 'select'; ids: string[] }
  | { type: 'load'; snapshot: PlannerSnapshot }

export function emptyState(geometry: RoomGeometry): PlannerState {
  return { geometry, items: [], selection: [], revision: 0 }
}

/**
 * Put a new outline on the room without losing track of the furniture.
 *
 * Re-origining the outline is a translation of the whole room, and the items are
 * held in the same coordinate space - so the identical translation has to reach
 * them or the whole layout drifts a wall's width every time somebody types a
 * length. That was true of the wall-length editor before rooms had corners you
 * could drag, and it will be true of anything else that moves the origin.
 */
function applyShape(
  state: PlannerState,
  vertices: Vertex[],
  settle: boolean,
  bump: (next: Omit<PlannerState, 'revision'>) => PlannerState,
): PlannerState {
  if (vertices.length < 3) return state
  if (!settle) {
    return bump({ ...state, geometry: { ...state.geometry, vertices } })
  }

  const wound = normaliseWinding(vertices)
  const moved = normaliseOrigin(wound)
  const first = wound[0]
  const shifted = moved[0]
  const dx = first && shifted ? shifted.x - first.x : 0
  const dy = first && shifted ? shifted.y - first.y : 0
  const geometry = withFittedOpenings({ ...state.geometry, vertices: moved })

  const items = state.items.map((item) => {
    if (item.staged) return item
    const followed = { ...item, x: item.x + dx, y: item.y + dy }
    // Anything the new outline no longer contains goes to the tray. Deleting it
    // would throw away a choice somebody made; leaving it outside the walls would
    // quietly put it in the car park.
    return itemInsideRoom(followed, geometry) ? followed : { ...followed, staged: true, parentId: null }
  })

  return bump({ ...state, geometry, items })
}

/**
 * Every door and window put back on the wall it belongs to, after the walls have
 * moved.
 *
 * A wall shortened past a door has to do something with the door, and there are
 * only two honest answers: slide it along, or admit the wall cannot hold it any
 * more. Silently leaving it hanging off the end is the third answer, and it
 * produces a room that draws a doorway in mid-air and a 3D view with a hole in
 * the outside world.
 */
function withFittedOpenings(geometry: RoomGeometry): RoomGeometry {
  if (geometry.openings.length === 0) return geometry
  const openings = geometry.openings.flatMap((opening) => {
    const fitted = fitOpeningToWall(geometry, opening)
    return fitted ? [fitted] : []
  })
  return { ...geometry, openings }
}

/**
 * Whether this step of a drag is taking the item away from the wall it is on.
 *
 * Snapping is applied per pointer event, and a drag arrives as a stream of them
 * a few pixels apart. An item already flush against a wall therefore had every
 * small step away from it undone by the very next snap, and no amount of
 * dragging could ever accumulate the quarter-metre needed to escape - the thing
 * was welded to the wall. Snapping should pull an item IN and never pull it
 * back, so a step that increases the distance is left alone; the moment the
 * shopper drags towards a wall again, snapping resumes as before.
 */
function movingAwayFromWall(before: PlanItem, after: PlanItem, geometry: RoomGeometry): boolean {
  const from = nearestWall({ x: before.x, y: before.y }, geometry.vertices)
  const to = nearestWall({ x: after.x, y: after.y }, geometry.vertices)
  if (!from || !to) return false
  return to.distanceMm > from.distanceMm + 0.5
}

/** The same escape, for the furniture. See movingAwayFromWall - the trap is identical. */
function movingAwayFromItems(before: PlanItem, after: PlanItem, others: PlanItem[]): boolean {
  const from = nearestItemGapMm(before, others)
  const to = nearestItemGapMm(after, others)
  if (from === null || to === null) return false
  return to > from + 0.5
}

/**
 * Everything a snap may consider: placed, not this item, and not being dragged
 * along with it. A multi-selection snapping to its own members would fight
 * itself on every pointer event.
 */
function snapNeighbours(items: PlanItem[], moving: Set<string>): PlanItem[] {
  return items.filter((item) => !item.staged && !moving.has(item.id))
}

/**
 * One drag step's worth of snapping: to the walls, and then to the furniture.
 *
 * In that order, and both escapable. The wall decides which way the item faces,
 * so it goes first; the neighbours then slide it along that wall until it is
 * flush with whatever is beside it, which is how a bank of desks gets built with
 * a mouse instead of with the number fields.
 */
function snapPlacement(moved: PlanItem, from: PlanItem, neighbours: PlanItem[], geometry: RoomGeometry): PlanItem {
  const walled = movingAwayFromWall(from, moved, geometry) ? moved : snapToWall(moved, geometry)
  return movingAwayFromItems(from, walled, neighbours) ? walled : snapToItems(walled, neighbours)
}

function makeItem(id: string, product: ProductSize, x: number, y: number, staged: boolean): PlanItem {
  return {
    id,
    productId: product.productId,
    x: Math.round(x),
    y: Math.round(y),
    z: 0,
    yaw: 0,
    widthMm: product.widthMm,
    depthMm: product.depthMm,
    heightMm: product.heightMm,
    sizeSource: product.sizeSource,
    mount: product.mount,
    parentId: null,
    wallIndex: null,
    manualSize: false,
    staged,
  }
}

export function plannerReducer(state: PlannerState, action: PlannerAction): PlannerState {
  const bump = (next: Omit<PlannerState, 'revision'>): PlannerState => ({ ...next, revision: state.revision + 1 })

  switch (action.type) {
    case 'load':
      return { geometry: action.snapshot.geometry, items: action.snapshot.items, selection: [], revision: state.revision + 1 }

    case 'select':
      return { ...state, selection: action.ids }

    case 'set-geometry': {
      const geometry = withFittedOpenings({ ...action.geometry, vertices: normaliseOrigin(normaliseWinding(action.geometry.vertices)) })
      // A wholesale replacement can be a much smaller room - "start the room
      // again" is exactly that - so anything the new outline no longer contains
      // goes to the tray. Deleting somebody's choices because they redrew the
      // walls would be unforgivable; leaving them outside is merely baffling.
      const items = state.items.map((item) =>
        item.staged || itemInsideRoom(item, geometry) ? item : { ...item, staged: true, parentId: null },
      )
      return bump({ ...state, geometry, items })
    }

    case 'set-wall-length':
      return applyShape(state, setWallLength(state.geometry.vertices, action.wallIndex, action.lengthMm), true, bump)

    case 'set-shape':
      return applyShape(state, action.vertices, action.settle ?? false, bump)

    case 'add-item': {
      const item = makeItem(action.id, action.product, action.x, action.y, action.staged ?? false)
      const placed = action.staged ? item : clampItemIntoRoom(item, state.geometry)
      return bump({ ...state, items: [...state.items, placed], selection: [placed.id] })
    }

    case 'move-items': {
      const moving = new Set(action.ids)
      // Anything mounted on or tucked under a moving item comes with it. That is
      // what makes a desk a desk rather than a desk and four things that happen
      // to be near it.
      for (const item of state.items) {
        if (item.parentId && moving.has(item.parentId)) moving.add(item.id)
      }
      const neighbours = snapNeighbours(state.items, moving)
      const items = state.items.map((item) => {
        if (!moving.has(item.id) || item.staged) return item
        const moved = { ...item, x: Math.round(item.x + action.dx), y: Math.round(item.y + action.dy) }
        // A child follows its parent and is not snapped on its own: a monitor
        // arm that clicked onto the nearest wall halfway through moving the desk
        // would be a poltergeist.
        const snapped = action.snap && !item.parentId
          ? snapPlacement(moved, item, neighbours, state.geometry)
          : moved
        return clampItemIntoRoom(snapped, state.geometry)
      })
      return bump({ ...state, items })
    }

    case 'place-item': {
      const neighbours = snapNeighbours(state.items, new Set([action.id]))
      const items = state.items.map((item) => {
        if (item.id !== action.id) return item
        const moved = { ...item, x: Math.round(action.x), y: Math.round(action.y), staged: false }
        // Dropped rather than dragged, so there is no previous step to be moving
        // away from and the snaps are offered unconditionally.
        const snapped = action.snap ? snapToItems(snapToWall(moved, state.geometry), neighbours) : moved
        return clampItemIntoRoom(snapped, state.geometry)
      })
      return bump({ ...state, items })
    }

    case 'rotate-items': {
      const rotating = new Set(action.ids)
      // Snapping rounds the turn, so what was actually applied is not always
      // what was asked for - and the children have to follow what the parent
      // really did, or a snapped desk and the arm mounted on it end up at
      // different angles.
      const applied = new Map<string, number>()
      const turned = state.items.map((item) => {
        if (!rotating.has(item.id)) return item
        const yaw = action.snap ? snapYaw(item.yaw + action.deltaDeg) : item.yaw + action.deltaDeg
        applied.set(item.id, yaw - item.yaw)
        return { ...item, yaw }
      })

      // Anything mounted on or tucked under a turning item comes round WITH it,
      // about the parent's own centre. A monitor arm that keeps its spot on the
      // floor while the desk turns out from under it is not attached to
      // anything, whatever the plan says.
      const before = new Map(state.items.map((item) => [item.id, item]))
      const items = turned.map((item) => {
        if (rotating.has(item.id) || !item.parentId) return item
        const delta = applied.get(item.parentId)
        const parent = before.get(item.parentId)
        if (delta === undefined || !parent) return item
        const orbit = rotatePoint(item.x - parent.x, item.y - parent.y, delta)
        return { ...item, x: Math.round(parent.x + orbit.x), y: Math.round(parent.y + orbit.y), yaw: item.yaw + delta }
      })
      return bump({ ...state, items })
    }

    case 'set-item': {
      const items = state.items.map((item) => {
        if (item.id !== action.id) return item
        const next = { ...item, ...action.patch }
        return next.staged ? next : clampItemIntoRoom(next, state.geometry)
      })
      return bump({ ...state, items })
    }

    case 'delete-items': {
      const doomed = new Set(action.ids)
      const items = state.items
        .filter((item) => !doomed.has(item.id))
        // A child whose parent has gone is detached rather than deleted with it:
        // deleting a desk should not silently take the monitor arm somebody chose.
        .map((item) => (item.parentId && doomed.has(item.parentId) ? { ...item, parentId: null } : item))
      return bump({ ...state, items, selection: [] })
    }

    case 'duplicate-items': {
      const source = state.items.filter((item) => action.ids.includes(item.id))
      const copies = source.map((item, index) => {
        const id = action.newIds[index]
        if (!id) return null
        return clampItemIntoRoom({ ...item, id, parentId: null, x: item.x + action.offsetMm, y: item.y + action.offsetMm }, state.geometry)
      })
      const added = copies.filter((item): item is PlanItem => item !== null)
      return bump({ ...state, items: [...state.items, ...added], selection: added.map((item) => item.id) })
    }

    case 'array-item': {
      // The repetition tool Deskwell's actual buyer needs. Twenty desks in a row
      // is one gesture, and it costs one geometry at draw time because identical
      // variants are instanced.
      const source = state.items.find((item) => item.id === action.id)
      if (!source) return state
      const rad = (action.alongYaw * Math.PI) / 180
      const added: PlanItem[] = []
      for (let step = 1; step <= action.count; step++) {
        const id = action.newIds[step - 1]
        if (!id) continue
        const offset = action.spacingMm * step
        added.push(
          clampItemIntoRoom(
            { ...source, id, parentId: null, x: Math.round(source.x + Math.cos(rad) * offset), y: Math.round(source.y + Math.sin(rad) * offset) },
            state.geometry,
          ),
        )
      }
      return bump({ ...state, items: [...state.items, ...added], selection: added.map((item) => item.id) })
    }

    case 'replace-product': {
      // "These twelve desks, in oak instead of white." With repetition tools
      // putting twenty identical items in a room, doing this one at a time is not
      // a workable interaction - and it is the single most likely thing a buyer
      // does after seeing the total.
      const target = new Set(action.ids)
      const items = state.items.map((item) => {
        if (!target.has(item.id)) return item
        return clampItemIntoRoom(
          {
            ...item,
            productId: action.product.productId,
            widthMm: item.manualSize ? item.widthMm : action.product.widthMm,
            depthMm: item.manualSize ? item.depthMm : action.product.depthMm,
            heightMm: item.manualSize ? item.heightMm : action.product.heightMm,
            sizeSource: item.manualSize ? item.sizeSource : action.product.sizeSource,
          },
          state.geometry,
        )
      })
      return bump({ ...state, items })
    }

    case 'stage-items': {
      const target = new Set(action.ids)
      const items = state.items.map((item) => (target.has(item.id) ? { ...item, staged: true, parentId: null } : item))
      return bump({ ...state, items, selection: [] })
    }

    case 'unstage-item': {
      const items = state.items.map((item) =>
        item.id === action.id ? clampItemIntoRoom({ ...item, staged: false, x: Math.round(action.x), y: Math.round(action.y) }, state.geometry) : item,
      )
      return bump({ ...state, items })
    }

    case 'add-opening': {
      // Doors and windows are a property of the ROOM, not of the layout, so they
      // live in the geometry beside the walls they are cut into - which is what
      // makes one of them survive a plan being duplicated and a wall being
      // dragged, and what lets the 3D view build a lintel over it.
      const defaults = OPENING_DEFAULTS[action.kind]
      const fitted = fitOpeningToWall(state.geometry, {
        id: action.id,
        kind: action.kind,
        wallIndex: action.wallIndex,
        // Dropped centred on where the wall was tapped, which is where somebody
        // pointing at a wall means.
        offsetMm: Math.round(action.offsetMm - defaults.widthMm / 2),
        ...defaults,
      })
      if (!fitted) return state
      return bump({ ...state, geometry: { ...state.geometry, openings: [...state.geometry.openings, fitted] } })
    }

    case 'set-opening': {
      const openings = state.geometry.openings.flatMap((opening) => {
        if (opening.id !== action.id) return [opening]
        const fitted = fitOpeningToWall(state.geometry, { ...opening, ...action.patch })
        return fitted ? [fitted] : []
      })
      return bump({ ...state, geometry: { ...state.geometry, openings } })
    }

    case 'delete-opening': {
      const openings = state.geometry.openings.filter((opening) => opening.id !== action.id)
      return bump({ ...state, geometry: { ...state.geometry, openings } })
    }

    case 'attach': {
      // One level only. Accessory-on-accessory stacking is deliberately out of
      // scope, and a cycle would be a hang rather than a feature.
      const items = state.items.map((item) => {
        if (item.id !== action.childId) return item
        if (action.parentId === action.childId) return item
        const parent = state.items.find((candidate) => candidate.id === action.parentId)
        if (action.parentId && (!parent || parent.parentId)) return item
        return { ...item, parentId: action.parentId }
      })
      return bump({ ...state, items })
    }

    default:
      return state
  }
}

/** The plan as it goes to the server. */
export function toPlanItems(state: PlannerState): PlanItems {
  return { version: PLAN_SCHEMA_VERSION, items: state.items }
}

/**
 * Which pairs actually fight, as opposed to merely sharing floor space.
 *
 * Legitimate overlaps are the norm in office planning: a chair tucks under a
 * desk, a pedestal slides under the desktop. So this warns; it never blocks -
 * and it does not warn at all about the arrangements people were aiming for.
 * `underTop` carries what the catalogue knows about the space beneath each
 * product, which is what tells a tucked-in chair from two desks in one spot.
 */
export function findClashes(items: PlanItem[], underTop: UnderTopSizes = {}): Array<{ a: string; b: string }> {
  const out: Array<{ a: string; b: string }> = []
  const placed = items.filter((item) => !item.staged)
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]
      const b = placed[j]
      if (!a || !b) continue
      if (itemsFight(a, b, underTop)) out.push({ a: a.id, b: b.id })
    }
  }
  return out
}

/**
 * Somewhere to put the next thing.
 *
 * Everything used to land dead centre, so placing four items produced one item
 * and three hidden underneath it - which looks exactly like a planner that has
 * stopped adding things. This walks outwards from the middle in rings until it
 * finds a spot inside the room where the new footprint touches nothing, and
 * gives up gracefully on the centre if the room is genuinely full: the shopper
 * can always drag it out, and refusing to place would be worse.
 */
export function findFreeSpot(
  items: PlanItem[],
  geometry: RoomGeometry,
  size: { widthMm: number; depthMm: number },
): { x: number; y: number } {
  const box = boundingBox(geometry.vertices)
  const centre = { x: Math.round((box.minX + box.maxX) / 2), y: Math.round((box.minY + box.maxY) / 2) }
  const placed = items.filter((item) => !item.staged)
  const step = Math.max(300, Math.round(Math.max(size.widthMm, size.depthMm) * 0.75) + 150)

  const free = (x: number, y: number): boolean => {
    const probe = { x, y, yaw: 0, widthMm: size.widthMm, depthMm: size.depthMm }
    if (!itemCorners(probe).every((corner) => pointInPolygon(corner, geometry.vertices))) return false
    return !placed.some((item) => footprintsOverlap(probe, item, -20))
  }

  if (free(centre.x, centre.y)) return centre
  for (let ring = 1; ring <= 14; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        // Only the ring itself, not the filled square - the inside was tried on
        // the way out.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const x = centre.x + dx * step
        const y = centre.y + dy * step
        if (free(x, y)) return { x, y }
      }
    }
  }
  return centre
}

/**
 * Whether a thing tucked under a desk actually fits under it.
 *
 * This is where "Height Under Top" earns its keep: green "fits" or red "5 cm too
 * tall", live, while the shopper is still dragging. Null means we do not know,
 * and saying nothing is the honest answer to that.
 */
export function underTopFit(
  child: PlanItem,
  parentUnderTop: { heightMm: number | null; widthMm: number | null },
): { fits: boolean; message: string } | null {
  if (parentUnderTop.heightMm === null) return null
  if (child.heightMm <= parentUnderTop.heightMm) return { fits: true, message: 'Fits underneath' }
  const over = child.heightMm - parentUnderTop.heightMm
  return { fits: false, message: `${Math.round(over / 10)} cm too tall to go under` }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export type History = { past: PlannerSnapshot[]; future: PlannerSnapshot[] }

export const HISTORY_DEPTH = 50

export function snapshot(state: PlannerState): PlannerSnapshot {
  return { geometry: state.geometry, items: state.items }
}

export function pushHistory(history: History, state: PlannerState): History {
  return { past: [...history.past, snapshot(state)].slice(-HISTORY_DEPTH), future: [] }
}

export function undo(history: History, state: PlannerState): { history: History; snapshot: PlannerSnapshot } | null {
  const previous = history.past[history.past.length - 1]
  if (!previous) return null
  return {
    history: { past: history.past.slice(0, -1), future: [snapshot(state), ...history.future].slice(0, HISTORY_DEPTH) },
    snapshot: previous,
  }
}

export function redo(history: History, state: PlannerState): { history: History; snapshot: PlannerSnapshot } | null {
  const next = history.future[0]
  if (!next) return null
  return {
    history: { past: [...history.past, snapshot(state)].slice(-HISTORY_DEPTH), future: history.future.slice(1) },
    snapshot: next,
  }
}
