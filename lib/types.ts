import type { Units } from '@/modules/space-planner-for-shop/lib/units'

// The shapes that go in the two jsonb columns, and the domain types the rest of
// the module speaks in.
//
// World conventions, stated once here and never varied anywhere else:
//   - Every distance is an integer number of millimetres.
//   - Plan coordinates are x (east) and y (south) on the floor. The 3D scene is
//     y-up, so a plan point (x, y) becomes a world point (x, 0, y).
//   - The plan origin is the minimum corner of the room's bounding box, so a
//     room's own numbers never go negative and a saved room can be compared with
//     another one without first working out where it thinks it is.
//   - Yaw is degrees, clockwise when looking down at the floor plan, zero facing
//     "north" (negative y).

export const ROOM_SCHEMA_VERSION = 1
export const PLAN_SCHEMA_VERSION = 1

export type Vertex = { x: number; y: number }

export type OpeningKind = 'door' | 'window' | 'opening'

/**
 * A gap in a wall. Positioned by which wall it is in and how far along that wall
 * it starts, rather than by absolute coordinates - so dragging the wall takes
 * the door with it, which is what everybody expects and nobody says out loud.
 */
export type WallOpening = {
  id: string
  kind: OpeningKind
  /** Index into `vertices`: the wall running from vertices[i] to vertices[i+1]. */
  wallIndex: number
  /** Distance from the wall's start vertex to the near edge of the opening. */
  offsetMm: number
  widthMm: number
  /** Height of the bottom of the opening above the floor. Zero for a door. */
  sillMm: number
  heightMm: number
}

/** A pillar, chimney breast or stair box: a polygon the furniture cannot occupy. */
export type Obstruction = {
  id: string
  label: string
  vertices: Vertex[]
  heightMm: number
}

export type RoomGeometry = {
  version: number
  /** Which units this room is shown in. The stored numbers are millimetres either way. */
  units: Units
  /** Closed loop, no repeated last point. Wound anticlockwise; the editor fixes it if not. */
  vertices: Vertex[]
  ceilingMm: number
  /**
   * Nominal wall thickness, extruded outwards. Typed wall lengths are always the
   * inside-of-room dimension - what somebody with a tape measure actually has -
   * so the interior stays true to the numbers and the walls are drawn around it.
   */
  wallThicknessMm: number
  openings: WallOpening[]
  obstructions: Obstruction[]
  floorFinish: string
  wallFinish: string
}

export type MountType = 'floor' | 'desk-surface' | 'desk-edge-clamp' | 'wall'
export const MOUNT_TYPES: MountType[] = ['floor', 'desk-surface', 'desk-edge-clamp', 'wall']

/** Which rung of the dimension ladder answered. Drives the "approx. size" badge. */
export type SizeSource = 'glb' | 'attribute' | 'category_default' | 'manual' | 'marker'

export type PlanItem = {
  id: string
  productId: string
  /** Centre of the item's footprint, in plan millimetres. */
  x: number
  y: number
  /** Height of the item's base above the floor. Non-zero only for mounted items. */
  z: number
  yaw: number
  widthMm: number
  depthMm: number
  heightMm: number
  sizeSource: SizeSource
  mount: MountType
  /**
   * The item this one is mounted on or tucked under. Moving the parent moves the
   * child; one tap detaches. Never more than one level deep - no
   * accessory-on-accessory stacking, deliberately.
   */
  parentId: string | null
  /** Which wall a wall-mounted item hangs on. */
  wallIndex: number | null
  /** True when the shopper typed the size themselves, so nothing overwrites it. */
  manualSize: boolean
  /** Set only when the item is in the staging tray rather than placed in the room. */
  staged: boolean
}

/**
 * What a referenced product was called, cost and looked like when the plan was
 * saved. Without it, a plan reopened after a supplier range is retired renders as
 * a grid of anonymous boxes.
 */
export type ProductSnapshotEntry = {
  name: string
  sku: string
  slug: string
  /** Net price, as a plain number. Never a Prisma.Decimal - see lib/db notes. */
  price: number
  taxClassId: string | null
  image: string | null
  parentId: string | null
  /** Human option summary for a variant child ("Oak / Black frame"). */
  optionSummary: string
}

export type ProductSnapshot = Record<string, ProductSnapshotEntry>

export type PlanItems = {
  version: number
  items: PlanItem[]
}

// ---------------------------------------------------------------------------
// Rows as the rest of the module sees them
// ---------------------------------------------------------------------------

export type SplRoom = {
  id: string
  memberId: string | null
  ownerUserId: string | null
  name: string
  notes: string
  geometry: RoomGeometry
  schemaVersion: number
  thumbnailMediaId: string | null
  createdAt: Date
  updatedAt: Date
}

export type SplPlan = {
  id: string
  roomId: string
  memberId: string | null
  ownerUserId: string | null
  name: string
  position: number
  items: PlanItems
  productSnapshot: ProductSnapshot
  shareToken: string | null
  schemaVersion: number
  thumbnailMediaId: string | null
  quoteId: string | null
  createdAt: Date
  updatedAt: Date
}

export type SplPlanVersion = {
  id: string
  planId: string
  version: number
  items: PlanItems
  productSnapshot: ProductSnapshot
  label: string | null
  createdAt: Date
}

export type SplDimensions = {
  productId: string
  widthMm: number | null
  depthMm: number | null
  heightMm: number | null
  source: SizeSource
  parsedFrom: string
  conflict: boolean
  conflictNote: string
  mountType: MountType
  productUpdatedAt: Date | null
  stale: boolean
  resolvedAt: Date
}

export type SplModelMeta = {
  id: string
  scope: 'file' | 'product'
  modelId: string | null
  productId: string | null
  yawOffsetDegrees: number
  footprintOverride: { widthMm: number; depthMm: number } | null
  noDecimation: boolean
  mountType: MountType | null
  notes: string
  reviewedAt: Date | null
}

export type SplCategoryDefault = {
  id: string
  categoryId: string
  widthMm: number | null
  depthMm: number | null
  heightMm: number | null
  mountType: MountType
}

export type BackfillStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'CANCELLED' | 'FAILED'

export type SplBackfillJob = {
  id: string
  kind: string
  status: BackfillStatus
  cursor: number
  total: number
  resolvedCount: number
  skippedCount: number
  failedCount: number
  error: string
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type RenderStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'

export type SplRenderJob = {
  id: string
  planId: string
  memberId: string | null
  status: RenderStatus
  params: Record<string, unknown>
  planUpdatedAt: Date | null
  resultMediaId: string | null
  resultUrl: string
  error: string
  /** The Fly machine rendering this one, so it can be destroyed the moment the
   * picture lands. Empty on a job that never got as far as a machine. */
  machineId: string
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Empty values
// ---------------------------------------------------------------------------

/** A plain 4 m x 3 m room, used as the "just give me something" starting point. */
export function defaultRoomGeometry(): RoomGeometry {
  return {
    version: ROOM_SCHEMA_VERSION,
    units: 'metric',
    vertices: [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 3000 },
      { x: 0, y: 3000 },
    ],
    ceilingMm: 2400,
    wallThicknessMm: 100,
    openings: [],
    obstructions: [],
    floorFinish: 'oak',
    wallFinish: 'white',
  }
}

export function emptyPlanItems(): PlanItems {
  return { version: PLAN_SCHEMA_VERSION, items: [] }
}
