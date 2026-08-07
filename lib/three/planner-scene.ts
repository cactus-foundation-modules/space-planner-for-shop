'use client'

import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { instanceKey } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { SceneDescription, SceneNode } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import {
  EYE_HEIGHT_CEILING_GAP_M,
  EYE_HEIGHT_MIN_M,
  EYE_HEIGHT_STANDING_M,
} from '@/modules/space-planner-for-shop/lib/types'
import type { SavedCamera } from '@/modules/space-planner-for-shop/lib/types'
import { paintedModel, prepareModel } from '@/modules/space-planner-for-shop/lib/three/planner-model'
import type { FabricSlot, PrepareOptions } from '@/modules/space-planner-for-shop/lib/three/planner-model'
import { modelScaleFor } from '@/modules/space-planner-for-shop/lib/three/model-scale'
import type { P3dFormat } from '@/modules/product-3d-views-for-shop/lib/formats'

// Turning a scene description into something on screen.
//
// Three deliberate positions:
//
//   1. Nothing here re-derives the plan. The description comes from
//      scene-plan.ts and the render worker gets the same one, because two
//      assemblies of the same plan drift and nobody notices for months.
//   2. Placeholders are the MAIN PATH, not the fallback. Nineteen listings in
//      twenty have no model, so a clean labelled box with the product photo on
//      the front is what most of this tool draws, and it is styled to read as
//      intentional rather than as a failure.
//   3. Lighting is procedural (three's own room environment) - no HDRI to host,
//      nothing to fetch, no licence. p3d made the same call for the same reason.

export type SceneHandles = {
  scene: Scene
  camera: PerspectiveCamera
  renderer: WebGLRenderer
  itemGroup: Group
  dispose: () => void
}

const PLACEHOLDER_COLOUR = 0x9aa4ae
const FLOOR_COLOUR = 0xbfb5a4
const WALL_COLOUR = 0xeceae5
/** How solid a column looks. Low enough to see the furniture behind it, high
 *  enough that nobody mistakes it for a lighting artefact. */
const OBSTRUCTION_OPACITY = 0.72

export function createRenderer(canvas: HTMLCanvasElement): WebGLRenderer | null {
  try {
    const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' })
    // Capped on purpose. A retina laptop asking for four times the pixels is
    // where an integrated GPU starts dropping frames, and nobody planning an
    // office is inspecting anti-aliasing.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = ACESFilmicToneMapping
    return renderer
  } catch {
    // No WebGL. The 2D editor is plain canvas and carries on working - the caller
    // shows a notice rather than an error page.
    return null
  }
}

/**
 * The two ways of looking at a room, and why both are offered.
 *
 * Perspective is how it will look to somebody standing in it. Orthographic is
 * how it looks on a drawing: parallel lines stay parallel, so two identical
 * desks are identical on screen wherever they are in the room, and you can
 * compare them by eye. Buyers want the first; anybody checking a layout wants
 * the second.
 */
export type CameraKind = 'perspective' | 'orthographic'

export type PlannerCamera = PerspectiveCamera | OrthographicCamera

/** Half the height of the orthographic view, in metres. Framing sets it. */
function orthoHalfHeight(camera: OrthographicCamera): number {
  const stored = camera.userData.halfHeightM
  return typeof stored === 'number' && stored > 0 ? stored : 5
}

export function createCamera(kind: CameraKind): PlannerCamera {
  if (kind === 'orthographic') {
    // The frustum is nonsense until applyCameraAspect runs, which every caller
    // does immediately - the numbers depend on the canvas, and the canvas has no
    // size worth reading at the moment a camera is made.
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.05, 400)
    camera.position.set(4, 3, 6)
    return camera
  }
  const camera = new PerspectiveCamera(50, 1, 0.05, 200)
  camera.position.set(4, 3, 6)
  return camera
}

/** Fit whichever camera it is to the shape of the canvas. */
export function applyCameraAspect(camera: PlannerCamera, aspect: number): void {
  if ((camera as PerspectiveCamera).isPerspectiveCamera) {
    const perspective = camera as PerspectiveCamera
    perspective.aspect = aspect
    perspective.updateProjectionMatrix()
    return
  }
  const ortho = camera as OrthographicCamera
  const halfHeight = orthoHalfHeight(ortho)
  const halfWidth = halfHeight * Math.max(0.2, aspect)
  ortho.left = -halfWidth
  ortho.right = halfWidth
  ortho.top = halfHeight
  ortho.bottom = -halfHeight
  ortho.updateProjectionMatrix()
}

export function createScene(): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene()
  scene.background = null

  const camera = createCamera('perspective') as PerspectiveCamera

  // Toned down from where this started. With ACES tone mapping on top, an
  // ambient of 1.4 plus a key of 2.2 washed the floor and the walls to the same
  // near-white and the room lost its corners.
  //
  // Named, because dressForRender has to find the ambient to dial it back and
  // the key to hang a shadow camera off. Finding them by index into scene.children
  // works right up until somebody adds a fourth light.
  const ambient = new AmbientLight(0xffffff, 0.85)
  ambient.name = LIGHT_AMBIENT
  const key = new DirectionalLight(0xffffff, 1.5)
  key.name = LIGHT_KEY
  key.position.set(4, 8, 6)
  const fill = new DirectionalLight(0xffffff, 0.45)
  fill.name = LIGHT_FILL
  fill.position.set(-6, 4, -4)
  scene.add(ambient, key, fill)

  return { scene, camera }
}

export const LIGHT_AMBIENT = 'plannerAmbient'
export const LIGHT_KEY = 'plannerKey'
export const LIGHT_FILL = 'plannerFill'

/** Floor and walls. Rebuilt whole when the room changes - it is cheap and it is correct. */
export function buildRoom(description: SceneDescription): Group {
  const group = new Group()
  group.name = 'room'

  const shape = new Shape()
  description.floor.outline.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x, point.z)
    else shape.lineTo(point.x, point.z)
  })
  shape.closePath()

  // The floor runs unbroken under the columns. It used to be punched through
  // wherever one stood, which was invisible while they were solid and is a hole
  // showing the sky now that they are not.
  const floorGeometry = new ShapeGeometry(shape)
  floorGeometry.rotateX(Math.PI / 2)
  const floor = new Mesh(floorGeometry, new MeshStandardMaterial({ color: FLOOR_COLOUR, roughness: 0.9, side: DoubleSide }))
  floor.name = 'floor'
  group.add(floor)

  // Every wall carries the direction it faces, and the view hides the ones
  // between the camera and the room each frame (updateWallVisibility). Without
  // it a room is a closed box and an orbit camera outside it sees six opaque
  // outsides and nothing else - which is exactly what this drew before: a grey
  // crate with the furniture sealed inside.
  const wallMaterial = new MeshStandardMaterial({ color: WALL_COLOUR, roughness: 1, side: DoubleSide })
  for (const wall of description.walls) {
    for (const segment of wallSegments(wall)) {
      group.add(buildWallSegment(segment, wall, wallMaterial, description.centre))
    }
  }

  // Columns and pillars, stood up from the floor to their own height.
  //
  // This drew a lid and nothing else: one flat plate floating at pillar height
  // over a hole in the floor. From directly above it looked plausible and from
  // every angle anybody actually uses it was a hairline or nothing at all, which
  // is why columns read as having failed to render.
  //
  // Deliberately a little see-through. An opaque column standing between the
  // camera and a desk hides the desk, and looking at the furniture is the whole
  // reason for switching to 3D. Solid enough to read as structure, thin enough
  // to read the chair behind it. One material for the lot, so a room full of
  // pillars is one material to upload and one to dispose.
  const obstructionMaterial = new MeshStandardMaterial({
    color: WALL_COLOUR,
    roughness: 1,
    transparent: true,
    opacity: OBSTRUCTION_OPACITY,
  })
  for (const obstruction of description.obstructions) {
    const solid = new Shape()
    obstruction.outline.forEach((point, index) => {
      if (index === 0) solid.moveTo(point.x, point.z)
      else solid.lineTo(point.x, point.z)
    })
    solid.closePath()
    // Extrusion runs along the shape's own +Z, so the rotation that lays the
    // floor flat also stands this up - and drops it below the floor on the way,
    // hence the lift by its own height afterwards.
    const geometry = new ExtrudeGeometry(solid, { depth: obstruction.heightM, bevelEnabled: false })
    geometry.rotateX(Math.PI / 2)
    geometry.translate(0, obstruction.heightM, 0)
    // Front faces only, unlike the walls. Both sides on a see-through solid
    // means every pixel blended twice and a column darker than the wall it is
    // part of.
    const mesh = new Mesh(geometry, obstructionMaterial)
    mesh.name = `obstruction:${obstruction.id}`
    group.add(mesh)
  }

  return group
}

type WallSpan = { fromT: number; toT: number; baseM: number; heightM: number }

/**
 * A wall broken into the pieces that actually exist, once its doors and windows
 * are taken out.
 *
 * A door leaves a gap with a lintel above it; a window leaves a gap with a sill
 * below and a lintel above. Doing this as spans rather than as CSG keeps it
 * cheap, exact and debuggable, at the cost of not modelling a reveal - which
 * nobody planning furniture has ever wanted.
 */
export function wallSegments(wall: SceneDescription['walls'][number]): WallSpan[] {
  const length = Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
  if (length <= 0) return []

  const openings = wall.openings
    .map((opening) => {
      const startT = Math.hypot(opening.start.x - wall.a.x, opening.start.z - wall.a.z) / length
      const endT = Math.hypot(opening.end.x - wall.a.x, opening.end.z - wall.a.z) / length
      return { fromT: Math.min(startT, endT), toT: Math.max(startT, endT), sillM: opening.sillM, headM: opening.sillM + opening.heightM }
    })
    .sort((a, b) => a.fromT - b.fromT)

  const spans: WallSpan[] = []
  let cursor = 0
  for (const opening of openings) {
    if (opening.fromT > cursor) {
      spans.push({ fromT: cursor, toT: opening.fromT, baseM: 0, heightM: wall.heightM })
    }
    if (opening.sillM > 0) {
      spans.push({ fromT: opening.fromT, toT: opening.toT, baseM: 0, heightM: opening.sillM })
    }
    if (opening.headM < wall.heightM) {
      spans.push({ fromT: opening.fromT, toT: opening.toT, baseM: opening.headM, heightM: wall.heightM - opening.headM })
    }
    cursor = Math.max(cursor, opening.toT)
  }
  if (cursor < 1) spans.push({ fromT: cursor, toT: 1, baseM: 0, heightM: wall.heightM })

  return spans.filter((span) => span.toT - span.fromT > 0.001 && span.heightM > 0.001)
}

function buildWallSegment(
  span: WallSpan,
  wall: SceneDescription['walls'][number],
  material: MeshStandardMaterial,
  roomCentre: { x: number; z: number },
): Mesh {
  const dx = wall.b.x - wall.a.x
  const dz = wall.b.z - wall.a.z
  const length = Math.hypot(dx, dz)
  const segmentLength = length * (span.toT - span.fromT)
  const midT = (span.fromT + span.toT) / 2

  const geometry = new BoxGeometry(segmentLength, span.heightM, wall.thicknessM)
  const mesh = new Mesh(geometry, material)
  const x = wall.a.x + dx * midT
  const z = wall.a.z + dz * midT
  mesh.position.set(x, span.baseM + span.heightM / 2, z)
  mesh.rotation.y = -Math.atan2(dz, dx)

  // Which way this wall faces, pointing out of the room. Taken as the
  // perpendicular to the wall, then flipped if it happens to point back at the
  // middle - which is what keeps it right for an L-shaped room, where "away from
  // the centre" on its own is not good enough.
  const perpendicular = length > 0 ? { x: dz / length, z: -dx / length } : { x: 0, z: 1 }
  const awayFromCentre = (x - roomCentre.x) * perpendicular.x + (z - roomCentre.z) * perpendicular.z
  mesh.userData.outward = awayFromCentre >= 0 ? perpendicular : { x: -perpendicular.x, z: -perpendicular.z }
  return mesh
}

/**
 * The dolls-house effect: hide whichever walls stand between the camera and the
 * room.
 *
 * Cheap enough to run every frame (a handful of dot products) and the only thing
 * that makes an orbiting camera useful at all - a room is a closed box, and a
 * closed box seen from outside is a box. Inside the room every wall passes the
 * test, so standing in it looks exactly as it should.
 */
export function updateWallVisibility(room: Group, camera: PlannerCamera): void {
  for (const child of room.children) {
    const outward = child.userData.outward as { x: number; z: number } | undefined
    if (!outward) continue
    const toCamera = { x: camera.position.x - child.position.x, z: camera.position.z - child.position.z }
    child.visible = toCamera.x * outward.x + toCamera.z * outward.z <= 0.02
  }
}

/**
 * A placeholder: a clean box at the ladder-resolved size, with the product
 * photograph on its front face and its name on a canvas sprite above it.
 *
 * No text library, no fonts to load - a sprite drawn on a 2D canvas is the whole
 * mechanism, and it stays legible at any distance because it always faces the
 * camera.
 */
export function buildPlaceholder(node: SceneNode): Object3D {
  const group = new Group()
  const geometry = new BoxGeometry(node.size.width, node.size.height, node.size.depth)
  const material = new MeshStandardMaterial({
    color: PLACEHOLDER_COLOUR,
    roughness: 0.7,
    metalness: 0,
    transparent: true,
    opacity: node.approximate ? 0.82 : 0.95,
  })
  const box = new Mesh(geometry, material)
  box.position.y = node.size.height / 2
  group.add(box)

  if (node.imageUrl) {
    const loader = new TextureLoader()
    loader.setCrossOrigin('anonymous')
    loader.load(
      node.imageUrl,
      (texture) => {
        texture.colorSpace = SRGBColorSpace
        const decal = new Mesh(
          new BoxGeometry(node.size.width * 0.86, node.size.height * 0.86, 0.002),
          new MeshStandardMaterial({ map: texture, roughness: 0.8 }),
        )
        decal.position.set(0, node.size.height / 2, node.size.depth / 2 + 0.002)
        group.add(decal)
      },
      undefined,
      () => {
        // No picture, still a box with a name on it. Silently-visibly degraded,
        // never an error the shopper has to read.
      },
    )
  }

  group.add(buildLabel(node.label, node.size.height + 0.12))
  return group
}

// Label textures are shared by text. Twenty identical desks carry twenty labels
// reading the same thing, and drawing that canvas twenty times - on every item
// rebuild, which happens on every nudge - is pure waste.
const labelTextures = new Map<string, CanvasTexture>()

function labelTexture(text: string): CanvasTexture {
  const existing = labelTextures.get(text)
  if (existing) return existing
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (context) {
    context.fillStyle = 'rgba(20,22,24,0.78)'
    context.roundRect(0, 24, 512, 80, 16)
    context.fill()
    context.fillStyle = '#ffffff'
    context.font = '500 40px system-ui, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(text.slice(0, 28), 256, 64)
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  labelTextures.set(text, texture)
  return texture
}

/**
 * A name tag floating over an item.
 *
 * Sized to the thing it names, and clamped: a fixed world size means the tag on
 * a pedestal is the same nine hundred millimetres wide as the tag on a boardroom
 * table, which at eye level fills the room with billboards.
 */
export function buildLabel(text: string, y: number): Sprite {
  const sprite = new Sprite(
    new SpriteMaterial({
      map: labelTexture(text),
      transparent: true,
      depthTest: false,
      opacity: 0.85,
      // Constant on screen rather than in the room. A tag sized in metres is
      // legible from across the room and the size of a doormat when you stand
      // next to the thing it names, which is exactly what "stand in it" does.
      sizeAttenuation: false,
    }),
  )
  sprite.scale.set(0.15, 0.0375, 1)
  sprite.position.y = y
  // Drawn last, so a tag is never hidden inside the furniture it names but is
  // still ordered predictably against the other tags.
  sprite.renderOrder = 10
  return sprite
}

export type BuildItemsResult = {
  group: Group
  /** Items that fell back to a placeholder because their model would not load. */
  degraded: string[]
  /**
   * Items whose PLAN size was a guess but whose model has now been measured:
   * the mesh's footprint as drawn, in millimetres. The planner adopts these so
   * the flat plan and the 3D view can never disagree about how big a thing is -
   * which is exactly how a bench that is really five metres long used to sit on
   * the plan as an 80 cm box.
   */
  measured: Array<{ itemId: string; productId: string; widthMm: number; depthMm: number; heightMm: number }>
}

/**
 * A model the caller has already resolved, as the browser holds it.
 *
 * `cacheKey` is the query-stripped url and the only thing compared or stored;
 * `url` is freshly signed and good for this page load. The two fix-ups travel
 * with it because they belong to the FILE - the same chair used by forty
 * variants is turned the same way for all of them.
 */
export type SceneModelSource = {
  url: string
  cacheKey: string
  format: string
  yawOffsetDeg?: number
  noDecimation?: boolean
  /** Which paints this product wears, and the key they are cached under. See planner-model. */
  fabricKey?: string
  slots?: FabricSlot[]
  /**
   * The product's real overall size along `realAxis`, in metres, as recorded in
   * the 3D views material setup. Present, it settles the model's scale on its
   * own - see model-scale.ts. Null for a product nobody has measured that way,
   * which falls back to reconciling the mesh with the plan.
   *
   * Per VARIATION rather than per file: the same chair shell in two seat heights
   * is one model and two of these.
   */
  realMetres?: number | null
  realAxis?: 'height' | 'width'
}

/** Marks a subtree that is a clone of a cached prepared model - see disposeGroup. */
const SHARED_MODEL = 'sharedModel'

/**
 * Everything in the room.
 *
 * Instancing is the budget model: each distinct model file is prepared once and
 * then cloned per placement, so a twenty-desk bank costs one download, one parse
 * and one crunch. Budgets are counted in UNIQUE MODELS for the same reason - a
 * cap on placed items would refuse exactly the office fit-out this tool exists
 * for.
 */
export async function buildItems(
  description: SceneDescription,
  models: Map<string, SceneModelSource>,
  options: PrepareOptions & { maxUniqueModels: number },
): Promise<BuildItemsResult> {
  const group = new Group()
  group.name = 'items'
  const degraded: string[] = []
  const measured: BuildItemsResult['measured'] = []

  // Prepare each distinct file once, in placement order, up to the budget.
  // Beyond it, the remaining products draw as placeholders rather than the tab
  // running out of memory - a room that is partly schematic is far better than
  // a room that is a crashed canvas.
  const wanted = description.instanceGroups.slice(0, options.maxUniqueModels)
  // Keyed by FILE PLUS PAINTS, because that pair is what one prepared model in
  // the room actually is. Keyed on the file alone, a room holding the blue chair
  // and the black one drew whichever of them was resolved first, twice.
  const bySource = new Map<string, SceneModelSource>()
  for (const model of models.values()) {
    const key = instanceKey({ plainUrl: model.cacheKey, fabricKey: model.fabricKey ?? '' })
    if (!bySource.has(key)) bySource.set(key, model)
  }
  const readyByKey = new Map<string, Awaited<ReturnType<typeof prepareModel>>>()

  await Promise.all(
    wanted.map(async (entry) => {
      const source = bySource.get(entry.key)
      if (!source) return
      try {
        // The download, the crunch and the measurement are per FILE and shared
        // across colours; only the materials are per colour.
        const base = await prepareModel(source.cacheKey, source.url, source.format as P3dFormat, {
          ...options,
          // The file's own fix-ups, applied per model rather than per scene.
          // Passing the scene-wide defaults here is how the yaw correction an
          // owner typed in the admin reached nothing at all, and how a model
          // flagged "leave the detail alone" got decimated anyway.
          yawOffsetDeg: source.yawOffsetDeg ?? options.yawOffsetDeg,
          noDecimation: options.noDecimation || (source.noDecimation ?? false),
        })
        const slots = source.slots ?? []
        readyByKey.set(entry.key, slots.length > 0 ? await paintedModel(base, entry.key, slots) : base)
      } catch {
        // Fetch or parse failed. The item joins the placeholder path below.
      }
    }),
  )

  for (const node of description.nodes) {
    const ready = node.model ? readyByKey.get(instanceKey(node.model)) : undefined
    let object: Object3D

    if (ready) {
      // The prepared model carries its own transform - recentred on its
      // footprint, stood on the floor, turned by the file's yaw correction - and
      // that transform is the entire point of having prepared it. Placing the
      // item ON the clone overwrites all three, which is how every model in the
      // room came to hang off wherever its exporter happened to put the origin.
      // So the clone goes inside a holder and the HOLDER is what gets placed.
      const holder = new Group()
      holder.add(ready.object.clone(true))
      // Fit the measured mesh to the size the plan believes in - which is a
      // multiply by one wherever the two agree, and a judgement call wherever
      // they do not. The rules for that call, and why a straight per-axis
      // division was the wrong one, are in model-scale.ts.
      //
      // The real size is read PER PRODUCT rather than off the prepared model's
      // source, because `bySource` is keyed by file plus paints: two seat heights
      // of one chair in one fabric share an entry there and would otherwise share
      // a height, which is the exact thing this is here to stop.
      const placedSource = models.get(node.productId)
      const real = placedSource?.realMetres
        ? { metres: placedSource.realMetres, axis: placedSource.realAxis ?? 'height' }
        : null
      const scale = modelScaleFor(ready, node.size, node.approximate, real)
      holder.scale.set(scale.x, scale.y, scale.z)
      holder.userData[SHARED_MODEL] = true
      object = holder
      // The plan only guessed at this one's size; the mesh knows. Report the
      // footprint actually drawn so the flat plan can adopt it - but only a
      // sane one: a file exported in centimetres measures forty metres across,
      // and adopting that would trade a small wrong box for an enormous one.
      if (node.approximate) {
        const widthMm = Math.round(ready.widthMm * scale.x)
        const depthMm = Math.round(ready.depthMm * scale.z)
        const heightMm = Math.round(ready.heightMm * scale.y)
        if ([widthMm, depthMm, heightMm].every((mm) => Number.isFinite(mm) && mm >= 5 && mm <= 20_000)) {
          measured.push({ itemId: node.itemId, productId: node.productId, widthMm, depthMm, heightMm })
        }
      }
    } else {
      if (node.model) degraded.push(node.itemId)
      object = buildPlaceholder(node)
    }

    object.position.set(node.position.x, node.position.y, node.position.z)
    object.rotation.y = node.rotationY
    object.userData.itemId = node.itemId
    object.userData.productId = node.productId
    group.add(object)
  }

  return { group, degraded, measured }
}

/** The room's own bounding box in world metres, floor to ceiling. */
function roomBounds(description: SceneDescription): { width: number; depth: number; height: number } {
  const xs = description.floor.outline.map((point) => point.x)
  const zs = description.floor.outline.map((point) => point.z)
  return {
    width: Math.max(0.5, Math.max(...xs) - Math.min(...xs)),
    depth: Math.max(0.5, Math.max(...zs) - Math.min(...zs)),
    height: Math.max(2, description.ceilingM),
  }
}

/**
 * Frame the whole room, from a height a person would see it from.
 *
 * The distance has to answer BOTH fields of view. A camera parked at a multiple
 * of the room's longest side is right for a square canvas and hopelessly wrong
 * for the tall narrow one a phone gives you - which is how a 4 m room ends up
 * filling the screen with one wall.
 */
export function frameRoom(camera: PlannerCamera, description: SceneDescription): Vector3 {
  const bounds = roomBounds(description)
  const radius = 0.5 * Math.hypot(bounds.width, bounds.depth, bounds.height)
  const target = new Vector3(description.centre.x, bounds.height * 0.35, description.centre.z)

  if (!(camera as PerspectiveCamera).isPerspectiveCamera) {
    // An orthographic camera has no field of view to fit the room into: the
    // frustum IS the framing. So the distance only has to clear the geometry,
    // and the half-height is what decides how much of the room is on screen.
    const ortho = camera as OrthographicCamera
    ortho.userData.halfHeightM = radius * 1.08
    applyCameraAspect(ortho, (ortho.right - ortho.left) / Math.max(1e-6, ortho.top - ortho.bottom))
    const distance = radius * 3 + 2
    ortho.position.set(target.x + distance * 0.64, target.y + distance * 0.44, target.z + distance * 0.64)
    ortho.lookAt(target)
    return target
  }

  const perspective = camera as PerspectiveCamera
  const vFov = (perspective.fov * Math.PI) / 180
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.2, perspective.aspect))
  const distance = Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2)) * 0.98
  // Looking down the room's diagonal from about thirty degrees up: high enough
  // to read the layout, low enough that the furniture still looks like furniture
  // rather than a floor plan with shadows.
  camera.position.set(
    target.x + distance * 0.64,
    target.y + distance * 0.44,
    target.z + distance * 0.64,
  )
  camera.lookAt(target)
  return target
}

/**
 * Stand in the room, roughly at eye level, looking across it.
 *
 * At the wall rather than in the middle. The middle is where the furniture is -
 * the first thing placed lands there - so a camera parked at the centre put the
 * shopper's head inside a desk and showed them the underneath of a worktop.
 */
export function eyeLevel(camera: PlannerCamera, description: SceneDescription): Vector3 {
  const xs = description.floor.outline.map((point) => point.x)
  const zs = description.floor.outline.map((point) => point.z)
  const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
  const width = box.maxX - box.minX
  const depth = box.maxZ - box.minZ

  // Stand at the end of the room's LONGEST wall and look down it. Standing at
  // the nearest wall of a small room means standing a metre from the furniture,
  // and a view of the underside of one desktop is not what "stand in it"
  // promises: it is meant to be the moment the room feels real.
  const alongX = width >= depth
  const stand = 0.6
  const position = alongX
    ? new Vector3(box.minX + stand, 1.6, description.centre.z)
    : new Vector3(description.centre.x, 1.6, box.minZ + stand)
  const target = alongX
    ? new Vector3(box.maxX - 0.2, 1.15, description.centre.z)
    : new Vector3(description.centre.x, 1.15, box.maxZ - 0.2)

  camera.position.copy(position)
  camera.lookAt(target)
  return target
}

// ---------------------------------------------------------------------------
// Viewpoints somebody chose
// ---------------------------------------------------------------------------

/**
 * The camera as it stands, in the shape that gets stored.
 *
 * `target` comes in from the caller rather than being derived, because a camera
 * knows which way it is pointing and not how far away the thing it is pointing at
 * is. OrbitControls owns that number, and reconstructing it from the camera alone
 * means picking an arbitrary distance - which then quietly decides how far one
 * notch of the scroll wheel zooms when the view is restored.
 */
export function readCamera(camera: PlannerCamera, target: Vector3): SavedCamera {
  const perspective = (camera as PerspectiveCamera).isPerspectiveCamera ? (camera as PerspectiveCamera) : null
  return {
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    target: { x: target.x, y: target.y, z: target.z },
    fov: perspective ? perspective.fov : 50,
    projection: perspective ? 'perspective' : 'orthographic',
    zoom: camera.zoom,
  }
}

/**
 * Put the camera back where it was. Returns the target, for the controls.
 *
 * The projection is NOT switched here even when the saved view disagrees with the
 * live one - swapping projection means replacing the camera and its controls, and
 * that is the caller's business. What this does instead is honour the saved
 * framing on whichever camera it is handed, so restoring a perspective view onto
 * an orthographic camera gives the same standpoint drawn flat rather than
 * nothing at all.
 */
export function applyCamera(camera: PlannerCamera, saved: SavedCamera): Vector3 {
  const target = new Vector3(saved.target.x, saved.target.y, saved.target.z)
  camera.position.set(saved.position.x, saved.position.y, saved.position.z)
  if ((camera as PerspectiveCamera).isPerspectiveCamera) {
    const perspective = camera as PerspectiveCamera
    perspective.fov = saved.fov
  } else {
    camera.zoom = saved.zoom
  }
  camera.lookAt(target)
  camera.updateProjectionMatrix()
  return target
}

/** Somewhere between the floor and just under the ceiling. */
export function clampEyeHeight(metres: number, description: SceneDescription): number {
  const ceiling = Math.max(EYE_HEIGHT_MIN_M + 0.2, description.ceilingM - EYE_HEIGHT_CEILING_GAP_M)
  if (!Number.isFinite(metres)) return Math.min(EYE_HEIGHT_STANDING_M, ceiling)
  return Math.min(Math.max(metres, EYE_HEIGHT_MIN_M), ceiling)
}

/**
 * Raise or lower the eye without changing where it is looking.
 *
 * The target moves with the camera, by the same amount, on purpose. Moving the
 * camera alone would tip the view down as you rose - which is a pitch control,
 * not a height control, and it is already on the left mouse button. Moving both
 * keeps the horizon where it is and simply makes you taller, which is what
 * somebody dragging a slider labelled "eye height" is asking for.
 */
export function setEyeHeight(camera: PlannerCamera, target: Vector3, metres: number, description: SceneDescription): number {
  const wanted = clampEyeHeight(metres, description)
  const delta = wanted - camera.position.y
  camera.position.y += delta
  target.y += delta
  camera.lookAt(target)
  return wanted
}

// ---------------------------------------------------------------------------
// The render-only dressing
// ---------------------------------------------------------------------------

/**
 * Everything a still photograph gets that the live view does not.
 *
 * Split out here, and called ONLY from the render page, because the two views
 * want opposite things. The shopper's view is a thing being dragged around at
 * sixty frames a second on whatever phone they own; the photograph is one frame
 * on a machine with nothing else to do. Sharing a lighting rig between them meant
 * the photograph was the preview at a larger size, which is exactly the complaint
 * that produced this function.
 *
 * Three changes, in order of how much they matter:
 *
 *   1. **Image-based lighting.** three's own procedural room, pre-filtered into an
 *      environment map. Standard materials with nothing to reflect read as matte
 *      plastic no matter how many directional lights you point at them; this is
 *      the single biggest difference between "3D preview" and "photograph".
 *   2. **A shadow the key light actually casts.** The renderer's shadow map was
 *      already switched on and had been doing nothing at all, because no light
 *      was casting and no mesh was receiving. The light also has to be MOVED:
 *      its fixed position sat inside any room bigger than about eight metres, so
 *      even once it cast, it cast from the middle of the floor.
 *   3. **Ambient dialled back.** The environment now does the job the ambient was
 *      standing in for, and leaving both up washes the corners out - which is the
 *      exact failure the ambient was toned down for in the first place.
 *
 * Returns a dispose for the PMREM render target, which is a GPU allocation and
 * not garbage collected with the scene.
 */
export function dressForRender(opts: {
  renderer: WebGLRenderer
  scene: Scene
  description: SceneDescription
  /** Every group whose meshes should take part in shadowing. */
  groups: Object3D[]
}): () => void {
  const { renderer, scene, description, groups } = opts

  const pmrem = new PMREMGenerator(renderer)
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = environment.texture
  scene.environmentIntensity = 0.85

  const ambient = scene.getObjectByName(LIGHT_AMBIENT)
  if (ambient && 'intensity' in ambient) (ambient as AmbientLight).intensity = 0.22
  const fill = scene.getObjectByName(LIGHT_FILL)
  if (fill && 'intensity' in fill) (fill as DirectionalLight).intensity = 0.3

  const key = scene.getObjectByName(LIGHT_KEY) as DirectionalLight | undefined
  if (key) {
    const bounds = roomBounds(description)
    const radius = 0.5 * Math.hypot(bounds.width, bounds.depth) + bounds.height
    const centre = new Vector3(description.centre.x, 0, description.centre.z)

    // Keep the direction the room was lit from and push the lamp back outside
    // it. A directional light's position is only ever a direction plus a place to
    // hang the shadow camera - but that second part is why the fixed (4, 8, 6)
    // could not stay: in a ten-metre room it is a lamp standing on the carpet.
    const direction = new Vector3(4, 8, 6).normalize()
    key.position.copy(centre).addScaledVector(direction, radius * 2.2)
    key.target.position.copy(centre)
    scene.add(key.target)

    key.castShadow = true
    key.shadow.mapSize.set(4096, 4096)
    const extent = radius * 1.25
    key.shadow.camera.left = -extent
    key.shadow.camera.right = extent
    key.shadow.camera.top = extent
    key.shadow.camera.bottom = -extent
    key.shadow.camera.near = 0.1
    key.shadow.camera.far = radius * 5
    // normalBias rather than bias: the room is mostly large flat planes lit at a
    // shallow angle, which is precisely where a constant depth bias either leaves
    // acne or detaches every shadow from the thing casting it.
    key.shadow.normalBias = 0.02
    key.shadow.bias = -0.0004
    // Softens the edge without a second pass. Costs nothing on one frame.
    key.shadow.radius = 3
    key.shadow.camera.updateProjectionMatrix()
  }

  for (const group of groups) {
    group.traverse((object) => {
      const mesh = object as Mesh
      if (!mesh.isMesh) return
      // Labels are sprites and never cast; the floor receives but does not cast,
      // because a flat plane casting onto itself is nothing but shadow acne.
      const isFloor = mesh.name === 'floor'
      mesh.castShadow = !isFloor
      mesh.receiveShadow = true
    })
  }

  return () => {
    scene.environment = null
    environment.dispose()
    pmrem.dispose()
  }
}

/**
 * Give back what this group owns, and nothing that it merely borrows.
 *
 * Two things in here are shared and must survive:
 *
 *   - A cloned catalogue model. `Object3D.clone` copies geometry and material BY
 *     REFERENCE, so every clone of a chair shares one geometry with the prepared
 *     copy in the model cache and with each other. Disposing one frees the
 *     geometry the next rebuild is about to draw with - and since the items
 *     group is rebuilt on every change to the room, that is every change to the
 *     room. The symptom is furniture that goes blank or black the moment
 *     anything moves, which looks nothing like its cause.
 *   - Sprite geometry, which three shares across every sprite it has ever made.
 *     Disposing it takes every future label with it.
 *
 * Walked by hand rather than with traverse() so a shared subtree can be skipped
 * whole; traverse offers no way to stop going down.
 */
export function disposeGroup(object: Object3D): void {
  if (object.userData[SHARED_MODEL]) return

  const mesh = object as Mesh
  if (mesh.geometry && !(object as unknown as { isSprite?: boolean }).isSprite) mesh.geometry.dispose()
  const material = (mesh as unknown as { material?: MeshStandardMaterial | MeshStandardMaterial[] }).material
  if (material) {
    for (const entry of Array.isArray(material) ? material : [material]) entry.dispose()
  }

  for (const child of [...object.children]) disposeGroup(child)
}

export const SELECTION_COLOUR = new Color(0x2f6fed)
