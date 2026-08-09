import {
  boundingBox,
  clampItemIntoRoom,
  displacedItems,
  footprintsOverlap,
  itemCorners,
  OPENING_DEFAULTS,
  fitOpeningToWall,
  itemHitsObstruction,
  itemInsideRoom,
  itemsFight,
  nearestItemGapMm,
  nearestWall,
  normaliseGeometryWinding,
  normaliseOrigin,
  normaliseYaw,
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

/**
 * A product as the planner holds it: its size off the ladder, plus the words and
 * the money the panels print. Lives here rather than in the component because
 * two components hand one of these to a third - the browse panel resolves a
 * variation into one, and the planner places it.
 */
export type ProductInfo = ProductSize & {
  name: string
  image: string | null
  priceFormatted: string
  price: number
  /**
   * The price is a "from" - a listing whose variations are priced separately.
   *
   * It exists so nothing multiplies it into a definite total: "From £199" times
   * three was printed as a flat "£597", which is a number this shop has not
   * agreed to.
   */
  priceVaries?: boolean
  /** The listing behind a variant child, so counts roll up to the card browsed. */
  parentId?: string | null
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
  | { type: 'add-item'; product: ProductSize; x: number; y: number; staged?: boolean; id: string; modelContext?: PlanItem['modelContext']; basketLine?: PlanItem['basketLine']; basketBundle?: PlanItem['basketBundle'] }
  | { type: 'move-items'; ids: string[]; dx: number; dy: number; snap: boolean }
  | { type: 'place-item'; id: string; x: number; y: number; snap: boolean }
  | { type: 'rotate-items'; ids: string[]; deltaDeg: number; snap: boolean }
  | { type: 'set-item'; id: string; patch: Partial<PlanItem> }
  | { type: 'delete-items'; ids: string[] }
  /**
   * Empty the waiting list, whatever is on it when this lands.
   *
   * `basketOnly` keeps anything that did NOT come from a basket line. The tray
   * holds two quite different things: what the shopper brought over from their
   * basket, and what a redrawn room could no longer hold - and the second is the
   * module's promise that reshaping a room never deletes anybody's work.
   * Re-reading the basket must not take that away with it.
   */
  | { type: 'clear-staged'; basketOnly?: boolean }
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
  /** A support column, chimney breast or stair box, dropped as a rectangle
   * centred where the floor was tapped. Part of the ROOM, like a door: it
   * belongs to the walls it stands among, not to any one layout. */
  | { type: 'add-obstruction'; id: string; x: number; y: number; widthMm: number; depthMm: number; heightMm: number; label: string }
  /** Resizing keeps the centre still; anything else would slide a column along
   * the wall while its width was being typed. */
  | { type: 'set-obstruction'; id: string; patch: { label?: string; heightMm?: number; widthMm?: number; depthMm?: number } }
  /**
   * Slide a column.
   *
   * `settle` marks the end of the gesture, and only then is the furniture
   * judged. A drag arrives as a stream of pointer moves, so staging on every one
   * of them meant dragging a column across the room swept every desk it passed
   * over onto the waiting list - and dragging it back did not bring them home.
   * The room's own outline has worked this way from the start; see set-shape.
   */
  | { type: 'move-obstruction'; id: string; dx: number; dy: number; settle?: boolean }
  | { type: 'delete-obstruction'; id: string }
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

  // Wound through the geometry-level version so the doors and windows are
  // renumbered along with the walls they hang on - see normaliseGeometryWinding.
  const rewound = normaliseGeometryWinding({ ...state.geometry, vertices })
  const wound = rewound.vertices
  const moved = normaliseOrigin(wound)
  const first = wound[0]
  const shifted = moved[0]
  const dx = first && shifted ? shifted.x - first.x : 0
  const dy = first && shifted ? shifted.y - first.y : 0
  // The columns move with the outline, not just the furniture. They are stored
  // in the same plan coordinates the walls are, so an origin shift that left
  // them behind put every pillar where the room used to be - and now that the
  // displacement test reads them, that meant staging desks for standing in a
  // column that is somewhere else entirely.
  const geometry = withFittedOpenings({
    ...rewound,
    vertices: moved,
    obstructions: rewound.obstructions.map((obstruction) => ({
      ...obstruction,
      vertices: obstruction.vertices.map((vertex) => ({ x: vertex.x + dx, y: vertex.y + dy })),
    })),
  })

  // Everything follows the origin shift first, then the outline decides what it
  // can still hold. Deleting what it cannot would throw away a choice somebody
  // made; leaving it outside the walls would quietly put it in the car park.
  const followed = state.items.map((item) => (item.staged ? item : { ...item, x: item.x + dx, y: item.y + dy }))

  return bump({ ...state, geometry, items: withDisplacedStaged(followed, geometry) })
}

/**
 * A new set of columns, with anything this edit puts out of the room moved to
 * the waiting list.
 *
 * Dropping a column on a desk is a geometry edit like any other, and it was the
 * one that skipped this. The consequence was not the obvious one: the desk
 * stayed put on screen, but saving PUTs the room first, the room route runs the
 * same displacement rule over EVERY layout in that room, and so Options B and C
 * - which the shopper was not looking at - had their furniture moved to their
 * trays while the layout on screen kept its desk inside the pillar. The wrong
 * way round in both directions.
 */
function withObstructions(
  state: PlannerState,
  obstructions: RoomGeometry['obstructions'],
  touchedId: string,
  bump: (next: Omit<PlannerState, 'revision'>) => PlannerState,
): PlannerState {
  const geometry = { ...state.geometry, obstructions }
  // Only what THIS column is responsible for. Standing a desk in a column is a
  // legal state the planner warns about rather than prevents, so an item may
  // already be in one when another is renamed or dropped in a far corner - and
  // staging everything currently displaced meant an edit over here quietly took
  // furniture out of the room over there.
  //
  // The baseline is the room WITHOUT the column being edited, rather than the
  // room as it stood a moment ago: a drag has already moved the column by the
  // time it settles, so "as it stood a moment ago" would excuse the very thing
  // the shopper just did.
  const withoutTouched = { ...geometry, obstructions: obstructions.filter((entry) => entry.id !== touchedId) }
  const already = new Set(displacedItems(state.items, withoutTouched).map((item) => item.id))
  return bump({ ...state, geometry, items: withDisplacedStaged(state.items, geometry, already) })
}

/**
 * Everything the new geometry can no longer hold, put back on the waiting list.
 *
 * Through geometry's own displacedItems so this side and the server side agree
 * about what "no longer fits" means. They did not: this file tested only whether
 * the item was still inside the walls, while the room route also stages anything
 * standing in a column and takes an item's children with it. So a save wrote the
 * client's answer over the server's, and a desk left standing inside a pillar
 * came back looking perfectly fine - the one plan where the promise did not hold
 * being the one on screen.
 *
 * `exempt` names items that were ALREADY displaced before this edit, for callers
 * that must only act on what they themselves changed.
 */
function withDisplacedStaged(items: PlanItem[], geometry: RoomGeometry, exempt?: Set<string>): PlanItem[] {
  const displaced = new Set(
    displacedItems(items, geometry)
      .map((item) => item.id)
      .filter((id) => !exempt?.has(id)),
  )

  // displacedItems judges a child by its parent and never on its own, because
  // for the ordinary case - the parent moves, the child goes with it - that is
  // right. A room being RESHAPED is the case it is wrong for: pull a wall in far
  // enough and the desk still fits while the monitor arm behind it does not, and
  // nothing was then staging the arm. It stayed placed, outside the walls, still
  // attached to something inside them.
  const strandedChildren = items.filter(
    (item) => !item.staged && item.parentId !== null && !displaced.has(item.id) && !itemInsideRoom(item, geometry),
  )
  for (const child of strandedChildren) displaced.add(child.id)

  if (displaced.size === 0) return items
  return items.map((item) => {
    if (item.staged) return item
    // A child follows its parent onto the list, exactly as it follows it round
    // the room - a monitor arm left placed over a desk that has gone is not a
    // thing anybody meant.
    const goes = displaced.has(item.id) || (item.parentId !== null && displaced.has(item.parentId))
    return goes ? { ...item, staged: true, parentId: null } : item
  })
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

/** An axis-aligned rectangle about a centre, as an obstruction outline. */
function rectVertices(x: number, y: number, widthMm: number, depthMm: number): Vertex[] {
  const halfW = widthMm / 2
  const halfD = depthMm / 2
  return [
    { x: Math.round(x - halfW), y: Math.round(y - halfD) },
    { x: Math.round(x + halfW), y: Math.round(y - halfD) },
    { x: Math.round(x + halfW), y: Math.round(y + halfD) },
    { x: Math.round(x - halfW), y: Math.round(y + halfD) },
  ]
}

function makeItem(
  id: string, product: ProductSize, x: number, y: number, staged: boolean,
  modelContext: PlanItem['modelContext'] = null,
  basketLine: PlanItem['basketLine'] = null,
  basketBundle: PlanItem['basketBundle'] = null,
): PlanItem {
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
    modelContext,
    basketLine,
    basketBundle,
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
      const rewound = normaliseGeometryWinding(action.geometry)
      const geometry = withFittedOpenings({ ...rewound, vertices: normaliseOrigin(rewound.vertices) })
      // A wholesale replacement can be a much smaller room - "start the room
      // again" is exactly that - so anything the new outline no longer holds
      // goes to the tray. Deleting somebody's choices because they redrew the
      // walls would be unforgivable; leaving them outside is merely baffling.
      return bump({ ...state, geometry, items: withDisplacedStaged(state.items, geometry) })
    }

    case 'set-wall-length':
      return applyShape(state, setWallLength(state.geometry.vertices, action.wallIndex, action.lengthMm), true, bump)

    case 'set-shape':
      return applyShape(state, action.vertices, action.settle ?? false, bump)

    case 'add-item': {
      const item = makeItem(action.id, action.product, action.x, action.y, action.staged ?? false, action.modelContext ?? null, action.basketLine ?? null, action.basketBundle ?? null)
      const placed = action.staged ? item : clampItemIntoRoom(item, state.geometry)
      return bump({ ...state, items: [...state.items, placed], selection: [placed.id] })
    }

    case 'move-items': {
      const moving = new Set(action.ids)
      // Anything mounted on or tucked under a moving item comes with it. That is
      // what makes a desk a desk rather than a desk and four things that happen
      // to be near it.
      // Walked to a fixed point rather than in one pass. `attach` refuses to
      // build a chain deeper than one level, but a plan saved before it did can
      // still hold one, and a single forward pass only picks a grandchild up
      // when the array happens to list it after its parent - so whether an item
      // came along depended on storage order.
      for (let added = true; added; ) {
        added = false
        for (const item of state.items) {
          if (item.parentId && moving.has(item.parentId) && !moving.has(item.id)) {
            moving.add(item.id)
            added = true
          }
        }
      }
      const neighbours = snapNeighbours(state.items, moving)

      // The parents move first, and what they ACTUALLY did is banked. Snapping
      // can add a quarter-metre of wall pull and rewrite the yaw, and the
      // children were being handed the raw drag instead - so a desk that
      // snapped flush to a wall left the monitor arm mounted on it hanging
      // wherever the finger had been. rotate-items has always worked this way;
      // this is the same fix on the other axis.
      const applied = new Map<string, { dx: number; dy: number; dYaw: number }>()
      const moved = state.items.map((item) => {
        if (!moving.has(item.id) || item.staged || item.parentId) return item
        const shifted = { ...item, x: Math.round(item.x + action.dx), y: Math.round(item.y + action.dy) }
        const snapped = action.snap ? snapPlacement(shifted, item, neighbours, state.geometry) : shifted
        const placed = clampItemIntoRoom(snapped, state.geometry)
        applied.set(item.id, { dx: placed.x - item.x, dy: placed.y - item.y, dYaw: placed.yaw - item.yaw })
        return placed
      })

      const items = moved.map((item) => {
        if (!moving.has(item.id) || item.staged || !item.parentId) return item
        // A child is never snapped on its own - a monitor arm that clicked onto
        // the nearest wall halfway through moving the desk would be a
        // poltergeist. It follows exactly what the parent did, orbiting the
        // parent's centre when the parent turned.
        const parentMove = applied.get(item.parentId)
        if (!parentMove) {
          return clampItemIntoRoom({ ...item, x: Math.round(item.x + action.dx), y: Math.round(item.y + action.dy) }, state.geometry)
        }
        const parentBefore = state.items.find((candidate) => candidate.id === item.parentId)
        const shifted = { ...item, x: item.x + parentMove.dx, y: item.y + parentMove.dy, yaw: item.yaw + parentMove.dYaw }
        if (parentBefore && parentMove.dYaw !== 0) {
          // rotatePoint turns about the origin, so the offset from the parent is
          // what gets turned and the parent's new centre is added back.
          const pivotX = parentBefore.x + parentMove.dx
          const pivotY = parentBefore.y + parentMove.dy
          const orbited = rotatePoint(shifted.x - pivotX, shifted.y - pivotY, parentMove.dYaw)
          shifted.x = pivotX + orbited.x
          shifted.y = pivotY + orbited.y
        }
        return clampItemIntoRoom({ ...shifted, x: Math.round(shifted.x), y: Math.round(shifted.y) }, state.geometry)
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
        const raw = action.snap ? snapYaw(item.yaw + action.deltaDeg) : item.yaw + action.deltaDeg
        // Wrapped, because nothing else wraps it and the angle only ever grows.
        // The server's schema tops out at 3600 degrees, so forty-one presses of
        // "Turn 90" - or one typed 99999 - made EVERY later save fail validation
        // with a message about a number, and the bad value was in the browser's
        // scratch copy too, so reloading did not clear it.
        const yaw = normaliseYaw(raw)
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
        // Wrapped like the parent's. The delta is the parent's WRAPPED turn, so
        // a desk crossing 360 hands its arm a delta of -340 rather than +20 -
        // which lands the arm in exactly the right place and then shows -340 in
        // the properties panel's "Turn" box.
        return {
          ...item,
          x: Math.round(parent.x + orbit.x),
          y: Math.round(parent.y + orbit.y),
          yaw: normaliseYaw(item.yaw + delta),
        }
      })
      return bump({ ...state, items })
    }

    case 'set-item': {
      const items = state.items.map((item) => {
        if (item.id !== action.id) return item
        const next = { ...item, ...action.patch }
        // The properties panel lets an angle be typed, and 99999 is a perfectly
        // ordinary thing to type into a box marked "Turn". Wrapped rather than
        // refused: every angle means something, just not the number they typed.
        if (action.patch.yaw !== undefined) next.yaw = normaliseYaw(next.yaw)
        return next.staged ? next : clampItemIntoRoom(next, state.geometry)
      })
      return bump({ ...state, items })
    }

    case 'clear-staged': {
      // Resolved here rather than by the caller, because the caller cannot know
      // which items are waiting by the time this lands. "Refresh from basket"
      // reads the basket over the network first, and a tray item the shopper
      // placed while that request was in flight was still marked waiting in the
      // list the caller had - so refreshing took it back out of the room.
      //
      // basketOnly spares anything the tray is holding for the OTHER reason: a
      // redrawn room could no longer fit it. Those carry no basket line, and
      // taking them out on a basket refresh would be this module deleting work
      // it had just promised to keep - under a tab whose only two buttons are
      // "Refresh from basket" and "Clear the list".
      const items = state.items.filter((item) => !item.staged || (action.basketOnly && !item.basketLine))
      if (items.length === state.items.length) return state
      return bump({ ...state, items, selection: state.selection.filter((id) => items.some((item) => item.id === id)) })
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

    case 'add-obstruction': {
      const obstruction = {
        id: action.id,
        label: action.label,
        vertices: rectVertices(action.x, action.y, action.widthMm, action.depthMm),
        heightMm: Math.round(action.heightMm),
      }
      return withObstructions(state, [...state.geometry.obstructions, obstruction], obstruction.id, bump)
    }

    case 'set-obstruction': {
      const obstructions = state.geometry.obstructions.map((obstruction) => {
        if (obstruction.id !== action.id) return obstruction
        const next = { ...obstruction }
        if (action.patch.label !== undefined) next.label = action.patch.label
        if (action.patch.heightMm !== undefined) next.heightMm = Math.max(1, Math.round(action.patch.heightMm))
        if (action.patch.widthMm !== undefined || action.patch.depthMm !== undefined) {
          // Rebuilt as a rectangle about the old centre. The UI only ever makes
          // rectangles, and resizing an imported polygon to a typed width has no
          // other honest reading than "make it that wide where it stands".
          const box = boundingBox(obstruction.vertices)
          const widthMm = Math.max(10, Math.round(action.patch.widthMm ?? box.maxX - box.minX))
          const depthMm = Math.max(10, Math.round(action.patch.depthMm ?? box.maxY - box.minY))
          next.vertices = rectVertices((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, widthMm, depthMm)
        }
        return next
      })
      // Only a change of SHAPE can put furniture out of the room. Renaming a
      // column or changing how tall it is leaves its footprint exactly where it
      // was, so running the displacement rule on those meant typing a better
      // name for a pillar took a desk standing in it out of the room - with no
      // message, and nothing to connect the two.
      const reshaped = action.patch.widthMm !== undefined || action.patch.depthMm !== undefined
      return reshaped
        ? withObstructions(state, obstructions, action.id, bump)
        : bump({ ...state, geometry: { ...state.geometry, obstructions } })
    }

    case 'move-obstruction': {
      const obstructions = state.geometry.obstructions.map((obstruction) =>
        obstruction.id === action.id
          ? {
              ...obstruction,
              vertices: obstruction.vertices.map((vertex) => ({
                x: Math.round(vertex.x + action.dx),
                y: Math.round(vertex.y + action.dy),
              })),
            }
          : obstruction,
      )
      // Mid-drag the column simply moves; the furniture is judged when the
      // finger comes up. See the action's own note for what judging every step
      // did to a column dragged across a room.
      return action.settle
        ? withObstructions(state, obstructions, action.id, bump)
        : bump({ ...state, geometry: { ...state.geometry, obstructions } })
    }

    case 'delete-obstruction': {
      const obstructions = state.geometry.obstructions.filter((obstruction) => obstruction.id !== action.id)
      return bump({ ...state, geometry: { ...state.geometry, obstructions } })
    }

    case 'attach': {
      // One level only. Accessory-on-accessory stacking is deliberately out of
      // scope, and a cycle would be a hang rather than a feature.
      //
      // Guarded from BOTH ends. Refusing a parent that is itself attached is
      // half the invariant: without also refusing a child that already has
      // children of its own, arm-to-desk followed by desk-to-bench built the
      // two-level chain anyway - and move-items resolves parents in one pass, so
      // whether a grandchild came along at all depended on the order the items
      // happened to be stored in.
      const hasChildren = state.items.some((candidate) => candidate.parentId === action.childId)
      const items = state.items.map((item) => {
        if (item.id !== action.childId) return item
        if (action.parentId === action.childId) return item
        if (action.parentId && hasChildren) return item
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
export function findClashes(items: PlanItem[], underTop: UnderTopSizes = {}, geometry?: RoomGeometry): Array<{ a: string; b: string }> {
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
  // A desk through a support column gets the same warning as a desk through a
  // desk. Warns, never blocks, like everything else here - but the server
  // stages anything left crossing one when the room is saved, so the warning
  // is also a heads-up about what saving will do.
  if (geometry) {
    for (const item of placed) {
      if (itemHitsObstruction(item, geometry)) out.push({ a: item.id, b: CLASH_WITH_OBSTRUCTION })
    }
  }
  return out
}

/**
 * What stands in for the second party when the first is standing in a column.
 *
 * A sentinel rather than an id, so anything counting or selecting the items in
 * a clash has to say so explicitly - one desk in a pillar reading as "2 things
 * are overlapping" is what happens when it does not.
 */
export const CLASH_WITH_OBSTRUCTION = 'obstruction'

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
/** Just the fields spot-finding reads, so a caller placing several things can
 *  probe against a running copy without manufacturing full plan items. */
export type SpotItem = Pick<PlanItem, 'x' | 'y' | 'yaw' | 'widthMm' | 'depthMm'> & { staged?: boolean }

export function findFreeSpot(
  items: SpotItem[],
  geometry: RoomGeometry,
  size: { widthMm: number; depthMm: number },
): { x: number; y: number; clear: boolean } {
  const box = boundingBox(geometry.vertices)
  const centre = { x: Math.round((box.minX + box.maxX) / 2), y: Math.round((box.minY + box.maxY) / 2) }
  const placed = items.filter((item) => !item.staged)
  const step = Math.max(300, Math.round(Math.max(size.widthMm, size.depthMm) * 0.75) + 150)

  const free = (x: number, y: number): boolean => {
    const probe = { x, y, yaw: 0, widthMm: size.widthMm, depthMm: size.depthMm }
    if (!itemCorners(probe).every((corner) => pointInPolygon(corner, geometry.vertices))) return false
    // A spot inside a support column is not a spot.
    if (itemHitsObstruction({ ...probe, z: 0 }, geometry)) return false
    return !placed.some((item) => footprintsOverlap(probe, item, -20))
  }

  if (free(centre.x, centre.y)) return { ...centre, clear: true }
  for (let ring = 1; ring <= 14; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        // Only the ring itself, not the filled square - the inside was tried on
        // the way out.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const x = centre.x + dx * step
        const y = centre.y + dy * step
        if (free(x, y)) return { x, y, clear: true }
      }
    }
  }
  // Nowhere free. The centre again - but SAID, so the caller can tell the
  // shopper it is on top of something rather than leaving them to spot the
  // clash colour.
  return { ...centre, clear: false }
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
