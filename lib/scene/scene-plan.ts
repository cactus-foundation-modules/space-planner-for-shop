import { boundingBox, openingSpan, polygonAreaM2, walls } from '@/modules/space-planner-for-shop/lib/geometry'
import type { PlanItem, PlanItems, ProductSnapshot, RoomGeometry } from '@/modules/space-planner-for-shop/lib/types'

// One scene, two consumers.
//
// The browser draws it and the render worker renders it, and they build it from
// this single description rather than each assembling their own from the plan.
// Divergence here is exactly how a photoreal render stops matching the plan
// somebody actually looked at, and it is the kind of divergence nobody notices
// for months because both pictures look plausible on their own.
//
// Pure and unit-testable: no three.js types cross this boundary, nothing here
// touches a network or a database. Model urls and fix-ups arrive already
// resolved, because resolving them needs the database and this file must run in
// a worker.

/** What the caller has already looked up for each product that has a model. */
export type ResolvedModel = {
  productId: string
  /** Query-stripped public url. Signed urls are minted at fetch time, never here. */
  plainUrl: string
  format: 'glb' | 'fbx' | 'obj'
  yawOffsetDeg: number
  noDecimation: boolean
  /**
   * Which set of fabric paints this product wears, or '' for none.
   *
   * Part of the instancing identity, not decoration: a whole chair range is one
   * file with the colour painted on at view time, so twenty blue chairs are one
   * instance and the black one beside them is another. Keyed on the paints
   * rather than on the product so a range sharing a fabric shares the work.
   */
  fabricKey: string
}

/** File plus paints - what one prepared, painted model in the scene is keyed by. */
export function instanceKey(model: Pick<ResolvedModel, 'plainUrl' | 'fabricKey'>): string {
  return model.fabricKey ? `${model.plainUrl}::${model.fabricKey}` : model.plainUrl
}

export type SceneNode = {
  itemId: string
  productId: string
  /** Null means a placeholder box with the product photo on the front. */
  model: ResolvedModel | null
  /** Metres, y-up, floor at y = 0. */
  position: { x: number; y: number; z: number }
  /** Radians about the world Y axis. */
  rotationY: number
  /** Metres. */
  size: { width: number; depth: number; height: number }
  label: string
  imageUrl: string | null
  /** True when the size came off a category default rather than the product. */
  approximate: boolean
  mount: PlanItem['mount']
}

export type SceneWall = {
  index: number
  /** Metres, in world x/z. */
  a: { x: number; z: number }
  b: { x: number; z: number }
  heightM: number
  thicknessM: number
  openings: Array<{
    id: string
    kind: string
    start: { x: number; z: number }
    end: { x: number; z: number }
    sillM: number
    heightM: number
  }>
}

export type SceneDescription = {
  units: RoomGeometry['units']
  floor: {
    /** Room outline in world x/z metres, in order. */
    outline: Array<{ x: number; z: number }>
    areaM2: number
    finish: string
  }
  walls: SceneWall[]
  wallFinish: string
  obstructions: Array<{ id: string; label: string; outline: Array<{ x: number; z: number }>; heightM: number }>
  ceilingM: number
  nodes: SceneNode[]
  /**
   * Which nodes share a model file, so twenty identical desks cost one crunched
   * geometry and twenty transforms rather than twenty downloads. This is the
   * whole budget model: budgets are per unique model, not per placed item.
   */
  instanceGroups: Array<{ key: string; plainUrl: string; fabricKey: string; format: ResolvedModel['format']; itemIds: string[] }>
  /** The centre of the room, in world metres - where a camera should look. */
  centre: { x: number; z: number }
  extentM: number
}

const MM = 1000

function toWorld(xMm: number, yMm: number): { x: number; z: number } {
  return { x: xMm / MM, z: yMm / MM }
}

/**
 * Build the description.
 *
 * `snapshot` supplies name and photograph for placeholders and labels; it is the
 * saved copy rather than a live lookup, so a plan opened after a product has been
 * retired still draws something recognisable instead of a blank box.
 */
export function buildScene(
  geometry: RoomGeometry,
  plan: PlanItems,
  snapshot: ProductSnapshot,
  models: Map<string, ResolvedModel>,
): SceneDescription {
  const outline = geometry.vertices.map((v) => toWorld(v.x, v.y))
  const box = boundingBox(geometry.vertices)
  const centre = toWorld((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2)
  const extentM = Math.max(box.maxX - box.minX, box.maxY - box.minY) / MM

  const sceneWalls: SceneWall[] = walls(geometry.vertices).map((wall) => ({
    index: wall.index,
    a: toWorld(wall.a.x, wall.a.y),
    b: toWorld(wall.b.x, wall.b.y),
    heightM: geometry.ceilingMm / MM,
    thicknessM: geometry.wallThicknessMm / MM,
    openings: geometry.openings
      .filter((opening) => opening.wallIndex === wall.index)
      .map((opening) => {
        const span = openingSpan(geometry, opening)
        return {
          id: opening.id,
          kind: opening.kind,
          start: span ? toWorld(span.start.x, span.start.y) : { x: 0, z: 0 },
          end: span ? toWorld(span.end.x, span.end.y) : { x: 0, z: 0 },
          sillM: opening.sillMm / MM,
          heightM: opening.heightMm / MM,
        }
      }),
  }))

  const placed = plan.items.filter((item) => !item.staged)

  const nodes: SceneNode[] = placed.map((item) => {
    const entry = snapshot[item.productId]
    // Exact-or-base: an item carrying an add-on combination draws its combined
    // model where one resolved (keyed `${productId}@@${context}`), else the
    // product's base model exactly as before.
    const model =
      (item.modelContext?.context ? models.get(`${item.productId}@@${item.modelContext.context}`) : null) ??
      models.get(item.productId) ??
      null
    const world = toWorld(item.x, item.y)
    return {
      itemId: item.id,
      productId: item.productId,
      model,
      position: { x: world.x, y: item.z / MM, z: world.z },
      // Plan yaw runs clockwise looking down at the floor; a positive rotation
      // about world +Y runs the other way. One negation, stated once, here.
      rotationY: (-item.yaw * Math.PI) / 180,
      size: { width: item.widthMm / MM, depth: item.depthMm / MM, height: item.heightMm / MM },
      label: entry?.name ?? 'Item',
      imageUrl: entry?.image ?? null,
      approximate: item.sizeSource === 'category_default' || item.sizeSource === 'marker',
      mount: item.mount,
    }
  })

  const groups = new Map<string, SceneDescription['instanceGroups'][number]>()
  for (const node of nodes) {
    if (!node.model) continue
    const key = instanceKey(node.model)
    const existing = groups.get(key)
    if (existing) existing.itemIds.push(node.itemId)
    else {
      groups.set(key, {
        key,
        plainUrl: node.model.plainUrl,
        fabricKey: node.model.fabricKey,
        format: node.model.format,
        itemIds: [node.itemId],
      })
    }
  }

  return {
    units: geometry.units,
    floor: { outline, areaM2: polygonAreaM2(geometry.vertices), finish: geometry.floorFinish },
    walls: sceneWalls,
    wallFinish: geometry.wallFinish,
    obstructions: geometry.obstructions.map((o) => ({
      id: o.id,
      label: o.label,
      outline: o.vertices.map((v) => toWorld(v.x, v.y)),
      heightM: o.heightMm / MM,
    })),
    ceilingM: geometry.ceilingMm / MM,
    nodes,
    instanceGroups: [...groups.values()],
    centre,
    extentM,
  }
}

/**
 * How many distinct model files a scene needs resident. The budget is measured
 * against this and never against the number of placed items - a bank of twenty
 * identical desks is one model, and a cap that counted instances would refuse
 * exactly the office fit-out this tool exists for.
 */
export function uniqueModelCount(scene: SceneDescription): number {
  return scene.instanceGroups.length
}

/**
 * Strip the query string before anything uses a url as a key.
 *
 * Asset urls are signed, and the same chair file is stored dozens of times under
 * dozens of stale tokens. Keyed on the raw url, a plan would download one file
 * once per row that mentions it; keyed on the query-stripped url, it downloads it
 * once. This is the single biggest saving in the whole pipeline, and it is one
 * line, which is why it is a named function nobody can quietly skip.
 */
export function plainUrl(url: string): string {
  const cut = url.indexOf('?')
  return cut === -1 ? url : url.slice(0, cut)
}
