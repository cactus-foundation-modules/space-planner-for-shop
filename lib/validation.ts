import { z } from 'zod'
import { MOUNT_TYPES, PLAN_SCHEMA_VERSION, ROOM_SCHEMA_VERSION } from '@/modules/space-planner-for-shop/lib/types'
import type { PlanItems, RoomGeometry, SavedCamera } from '@/modules/space-planner-for-shop/lib/types'

// Every write goes through here before it reaches a table.
//
// The payloads are shopper-supplied JSON blobs, which is the shape of thing that
// gets a table filled with rubbish the week after launch. Ceilings on vertex and
// item counts are as much about the browser as about the database - a plan with
// fifty thousand items is not a plan somebody made, and rendering it would take
// the tab down.

export const MAX_VERTICES = 64
export const MAX_OPENINGS = 64
export const MAX_OBSTRUCTIONS = 32
export const MAX_ITEMS = 400
export const MAX_PAYLOAD_BYTES = 512 * 1024

const mm = z.number().finite().min(-1_000_000).max(1_000_000)
const positiveMm = z.number().finite().min(0).max(1_000_000)

const VertexSchema = z.object({ x: mm, y: mm })

const WallOpeningSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['door', 'window', 'opening']),
  wallIndex: z.number().int().min(0).max(MAX_VERTICES - 1),
  offsetMm: positiveMm,
  widthMm: positiveMm,
  sillMm: positiveMm,
  heightMm: positiveMm,
})

const ObstructionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(120).default(''),
  vertices: z.array(VertexSchema).min(3).max(MAX_VERTICES),
  heightMm: positiveMm,
})

export const RoomGeometrySchema = z.object({
  version: z.number().int().min(1).max(ROOM_SCHEMA_VERSION),
  units: z.enum(['metric', 'imperial']).default('metric'),
  vertices: z.array(VertexSchema).min(3).max(MAX_VERTICES),
  ceilingMm: z.number().finite().min(1500).max(20_000),
  wallThicknessMm: z.number().finite().min(10).max(1000).default(100),
  openings: z.array(WallOpeningSchema).max(MAX_OPENINGS).default([]),
  obstructions: z.array(ObstructionSchema).max(MAX_OBSTRUCTIONS).default([]),
  floorFinish: z.string().max(40).default('oak'),
  wallFinish: z.string().max(40).default('white'),
})

export const PlanItemSchema = z.object({
  id: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  x: mm,
  y: mm,
  z: positiveMm.default(0),
  yaw: z.number().finite().min(-3600).max(3600),
  widthMm: z.number().finite().min(1).max(50_000),
  depthMm: z.number().finite().min(1).max(50_000),
  heightMm: z.number().finite().min(1).max(50_000),
  sizeSource: z.enum(['glb', 'attribute', 'category_default', 'manual', 'marker']),
  mount: z.enum(MOUNT_TYPES as [string, ...string[]]).transform((v) => v as PlanItems['items'][number]['mount']),
  parentId: z.string().max(64).nullable().default(null),
  wallIndex: z.number().int().min(0).max(MAX_VERTICES - 1).nullable().default(null),
  manualSize: z.boolean().default(false),
  staged: z.boolean().default(false),
  // Defaulted null so every plan saved before add-on combinations existed
  // parses exactly as it always did.
  modelContext: z
    .object({ context: z.string().max(120), extraValueIds: z.array(z.string().max(64)).max(40) })
    .nullable()
    .default(null),
})

export const PlanItemsSchema = z.object({
  version: z.number().int().min(1).max(PLAN_SCHEMA_VERSION),
  items: z.array(PlanItemSchema).max(MAX_ITEMS),
})

export const ProductSnapshotEntrySchema = z.object({
  name: z.string().max(400).default(''),
  sku: z.string().max(120).default(''),
  slug: z.string().max(400).default(''),
  price: z.number().finite().min(0).max(10_000_000).default(0),
  taxClassId: z.string().max(64).nullable().default(null),
  image: z.string().max(2000).nullable().default(null),
  parentId: z.string().max(64).nullable().default(null),
  optionSummary: z.string().max(400).default(''),
})

export const ProductSnapshotSchema = z.record(z.string().max(64), ProductSnapshotEntrySchema)

/**
 * A camera pose, in world metres.
 *
 * The bounds are generous on purpose - a camera outside the room is a legitimate
 * thing to save, because looking in through a missing wall is how you photograph
 * a small room - but they are bounds all the same: an infinity or a NaN reaching
 * three.js does not throw, it silently produces a black frame, and a black frame
 * is a render the customer paid a Fly machine for.
 */
const metres = z.number().finite().min(-1000).max(1000)
const MetreVectorSchema = z.object({ x: metres, y: metres, z: metres })

export const SavedCameraSchema = z.object({
  position: MetreVectorSchema,
  target: MetreVectorSchema,
  // 50 to match createCamera's perspective lens, so a record written before this
  // field existed restores to the camera the planner actually uses rather than to
  // a subtly different one nobody chose.
  fov: z.number().finite().min(10).max(120).default(50),
  projection: z.enum(['perspective', 'orthographic']).default('perspective'),
  zoom: z.number().finite().min(0.01).max(100).default(1),
})

export const MAX_VIEWS_PER_ROOM = 12

export const ViewWriteSchema = z.object({
  name: z.string().trim().min(1).max(80),
  camera: SavedCameraSchema,
})

export const ViewPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  camera: SavedCameraSchema.optional(),
  position: z.number().int().min(0).max(MAX_VIEWS_PER_ROOM).optional(),
})

export const RoomWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  notes: z.string().max(2000).default(''),
  geometry: RoomGeometrySchema,
})

export const PlanWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  items: PlanItemsSchema,
  productSnapshot: ProductSnapshotSchema.default({}),
})

export type RoomWrite = z.infer<typeof RoomWriteSchema>
export type PlanWrite = z.infer<typeof PlanWriteSchema>

/**
 * Reject an oversized body before parsing it.
 *
 * zod will happily walk a ten-megabyte object and tell you it is valid. The size
 * cap is the cheap guard that has to come first, because the expensive one runs
 * on whatever gets past it.
 */
export function payloadTooLarge(raw: string): boolean {
  return raw.length > MAX_PAYLOAD_BYTES
}

/**
 * A stored blob read back out. Anything that fails falls back to a safe default
 * rather than throwing: a row that has been through a schema change should render
 * as an empty room the member can fix, not as a five hundred on their account
 * page.
 */
export function readRoomGeometry(raw: unknown, fallback: RoomGeometry): RoomGeometry {
  const parsed = RoomGeometrySchema.safeParse(raw)
  return parsed.success ? (parsed.data as RoomGeometry) : fallback
}

export function readPlanItems(raw: unknown): PlanItems {
  const parsed = PlanItemsSchema.safeParse(raw)
  return parsed.success ? (parsed.data as PlanItems) : { version: PLAN_SCHEMA_VERSION, items: [] }
}

export function readProductSnapshot(raw: unknown): z.infer<typeof ProductSnapshotSchema> {
  const parsed = ProductSnapshotSchema.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

/**
 * A stored camera read back out.
 *
 * Null rather than a fallback pose, because there is no safe default here: a
 * made-up camera would be presented to the member as the view they saved, and
 * they would rightly conclude the feature loses their work. A view that will not
 * parse is a view the UI declines to offer.
 */
export function readSavedCamera(raw: unknown): SavedCamera | null {
  const parsed = SavedCameraSchema.safeParse(raw)
  return parsed.success ? (parsed.data as SavedCamera) : null
}
