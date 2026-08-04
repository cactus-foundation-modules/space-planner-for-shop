'use client'

import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Path,
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
import type { SceneDescription, SceneNode } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import { prepareModel } from '@/modules/space-planner-for-shop/lib/three/planner-model'
import type { PrepareOptions } from '@/modules/space-planner-for-shop/lib/three/planner-model'
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

const PLACEHOLDER_COLOUR = 0xb9c0c8
const FLOOR_COLOUR = 0xd9d2c7
const WALL_COLOUR = 0xf2f0ec

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

export function createScene(): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene()
  scene.background = null

  const camera = new PerspectiveCamera(50, 1, 0.05, 200)
  camera.position.set(4, 3, 6)

  const ambient = new AmbientLight(0xffffff, 1.4)
  const key = new DirectionalLight(0xffffff, 2.2)
  key.position.set(4, 8, 6)
  const fill = new DirectionalLight(0xffffff, 0.8)
  fill.position.set(-6, 4, -4)
  scene.add(ambient, key, fill)

  return { scene, camera }
}

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

  // Interior obstructions are holes in the floor shape. Triangulation with holes
  // comes from three's own earcut, so arbitrary polygons - L-shapes, bays,
  // chimney breasts - need no extra dependency.
  for (const obstruction of description.obstructions) {
    const hole = new Path()
    obstruction.outline.forEach((point, index) => {
      if (index === 0) hole.moveTo(point.x, point.z)
      else hole.lineTo(point.x, point.z)
    })
    hole.closePath()
    shape.holes.push(hole)
  }

  const floorGeometry = new ShapeGeometry(shape)
  floorGeometry.rotateX(Math.PI / 2)
  const floor = new Mesh(floorGeometry, new MeshStandardMaterial({ color: FLOOR_COLOUR, roughness: 0.9, side: DoubleSide }))
  floor.name = 'floor'
  group.add(floor)

  const wallMaterial = new MeshStandardMaterial({ color: WALL_COLOUR, roughness: 1, side: DoubleSide })
  for (const wall of description.walls) {
    for (const segment of wallSegments(wall)) {
      group.add(buildWallSegment(segment, wall, wallMaterial))
    }
  }

  // Obstructions get drawn as solids so a pillar reads as a pillar rather than
  // as a hole somebody's desk keeps refusing to go into.
  for (const obstruction of description.obstructions) {
    const solid = new Shape()
    obstruction.outline.forEach((point, index) => {
      if (index === 0) solid.moveTo(point.x, point.z)
      else solid.lineTo(point.x, point.z)
    })
    solid.closePath()
    const cap = new ShapeGeometry(solid)
    cap.rotateX(Math.PI / 2)
    cap.translate(0, obstruction.heightM, 0)
    group.add(new Mesh(cap, wallMaterial))
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

function buildWallSegment(span: WallSpan, wall: SceneDescription['walls'][number], material: MeshStandardMaterial): Mesh {
  const dx = wall.b.x - wall.a.x
  const dz = wall.b.z - wall.a.z
  const length = Math.hypot(dx, dz)
  const segmentLength = length * (span.toT - span.fromT)
  const midT = (span.fromT + span.toT) / 2

  const geometry = new BoxGeometry(segmentLength, span.heightM, wall.thicknessM)
  const mesh = new Mesh(geometry, material)
  mesh.position.set(
    wall.a.x + dx * midT,
    span.baseM + span.heightM / 2,
    wall.a.z + dz * midT,
  )
  mesh.rotation.y = -Math.atan2(dz, dx)
  return mesh
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

export function buildLabel(text: string, y: number): Sprite {
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
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthTest: false }))
  sprite.scale.set(0.9, 0.225, 1)
  sprite.position.y = y
  return sprite
}

export type BuildItemsResult = {
  group: Group
  /** Items that fell back to a placeholder because their model would not load. */
  degraded: string[]
}

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
  models: Map<string, { url: string; cacheKey: string; format: string }>,
  options: PrepareOptions & { maxUniqueModels: number },
): Promise<BuildItemsResult> {
  const group = new Group()
  group.name = 'items'
  const degraded: string[] = []

  // Prepare each distinct file once, in placement order, up to the budget.
  // Beyond it, the remaining products draw as placeholders rather than the tab
  // running out of memory - a room that is partly schematic is far better than
  // a room that is a crashed canvas.
  const wanted = description.instanceGroups.slice(0, options.maxUniqueModels)
  const readyByUrl = new Map<string, Awaited<ReturnType<typeof prepareModel>>>()

  await Promise.all(
    wanted.map(async (entry) => {
      const source = [...models.values()].find((model) => model.cacheKey === entry.plainUrl)
      if (!source) return
      try {
        readyByUrl.set(entry.plainUrl, await prepareModel(source.cacheKey, source.url, source.format as P3dFormat, options))
      } catch {
        // Fetch or parse failed. The item joins the placeholder path below.
      }
    }),
  )

  for (const node of description.nodes) {
    const ready = node.model ? readyByUrl.get(node.model.plainUrl) : undefined
    let object: Object3D

    if (ready) {
      object = ready.object.clone(true)
      // Scale the measured mesh to the size the plan believes in. Where the two
      // agree this is a multiply by one; where they do not, the plan wins on
      // screen and the disagreement is flagged in the admin rather than argued
      // with here.
      const scaleX = ready.widthMm > 0 ? (node.size.width * 1000) / ready.widthMm : 1
      const scaleY = ready.heightMm > 0 ? (node.size.height * 1000) / ready.heightMm : 1
      const scaleZ = ready.depthMm > 0 ? (node.size.depth * 1000) / ready.depthMm : 1
      object.scale.set(scaleX, scaleY, scaleZ)
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

  return { group, degraded }
}

/** Frame the whole room, from a height a person would see it from. */
export function frameRoom(camera: PerspectiveCamera, description: SceneDescription): void {
  const distance = Math.max(4, description.extentM * 1.4)
  camera.position.set(description.centre.x + distance * 0.6, distance * 0.7, description.centre.z + distance * 0.9)
  camera.lookAt(new Vector3(description.centre.x, 0.9, description.centre.z))
}

/** Stand in the room, roughly at eye level, looking across it. */
export function eyeLevel(camera: PerspectiveCamera, description: SceneDescription): void {
  camera.position.set(description.centre.x, 1.6, description.centre.z + description.extentM * 0.45)
  camera.lookAt(new Vector3(description.centre.x, 1.2, description.centre.z - description.extentM))
}

export function disposeGroup(group: Object3D): void {
  group.traverse((child) => {
    const mesh = child as Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const material = (mesh as unknown as { material?: MeshStandardMaterial | MeshStandardMaterial[] }).material
    if (!material) return
    for (const entry of Array.isArray(material) ? material : [material]) entry.dispose()
  })
}

export const SELECTION_COLOUR = new Color(0x2f6fed)
