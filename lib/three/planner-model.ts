'use client'

import { Box3, Mesh, Vector3 } from 'three'
import type { BufferGeometry, Material, Object3D, Texture } from 'three'
import { loadModel } from '@/modules/product-3d-views-for-shop/lib/three/load-model'
import type { P3dFormat } from '@/modules/product-3d-views-for-shop/lib/formats'

// Loading a catalogue model at REAL SIZE.
//
// This is the single most dangerous thing in the module, and it is worth being
// blunt about why. p3d's own pipeline ends in frameModel(), which normalises
// every model to a two-unit longest side centred on the origin. That is exactly
// right for a product viewer, where the model's job is to fill a frame. It is
// fatal here, where a desk has to be 1.6 m standing next to a 6 m wall.
//
// So the planner takes the PRE-NORMALISATION bounding box and never calls
// frameModel. Everything below is about turning a file we do not control into a
// thing that stands on the floor, faces the right way and is the size it says it
// is - and about admitting when it is not.

export type PreparedModel = {
  object: Object3D
  /** Measured from the mesh, in millimetres, after node transforms are applied. */
  widthMm: number
  depthMm: number
  heightMm: number
  triangles: number
}

export type PrepareOptions = {
  yawOffsetDeg: number
  noDecimation: boolean
  decimationTarget: number
  textureMaxPx: number
}

// Prepared models are cached per url for the life of the page, so a bank of
// twenty identical desks costs one download, one parse and one crunch. The
// instancing in planner-scene.ts is what makes the twenty transforms cheap; this
// is what makes the one model cheap.
//
// Deliberately in memory only. Persisting the crunched result to IndexedDB is
// the obvious next saving and is NOT in this build - see the README.
const prepared = new Map<string, Promise<PreparedModel>>()

export async function prepareModel(
  cacheKey: string,
  fetchUrl: string,
  format: P3dFormat,
  options: PrepareOptions,
): Promise<PreparedModel> {
  const existing = prepared.get(cacheKey)
  if (existing) return existing

  const entry = build(fetchUrl, format, options).catch((error) => {
    // A failed load must never poison the cache: a shopper whose connection came
    // back deserves a fresh attempt, not the old rejection handed straight back.
    prepared.delete(cacheKey)
    throw error
  })
  prepared.set(cacheKey, entry)
  return entry
}

export function clearPreparedModels(): void {
  prepared.clear()
}

async function build(url: string, format: P3dFormat, options: PrepareOptions): Promise<PreparedModel> {
  const object = await loadModel(url, format)

  // The file's own yaw correction goes on FIRST, and the file's own idea of
  // where the origin is goes in the bin. Both matter to what is measured next: a
  // model turned a quarter turn has its width and its depth the other way round,
  // and a footprint measured before the turn is the wrong way round for ever.
  object.position.set(0, 0, 0)
  object.rotation.y = (-options.yawOffsetDeg * Math.PI) / 180

  // Measure BEFORE anything is moved, with node world transforms applied.
  // Box3.setFromObject walks the graph and multiplies each geometry by its
  // node's world matrix, which is the whole point: node scales vary wildly
  // across this catalogue and a mesh-local bounding box would be nonsense.
  object.updateWorldMatrix(true, true)
  const box = new Box3().setFromObject(object)
  const size = box.getSize(new Vector3())
  const centre = box.getCenter(new Vector3())

  // Stand it on the floor, centred on its own footprint. Nothing here trusts the
  // file's own idea of where the origin is, because across this catalogue the
  // file's own idea is not consistent.
  //
  // The local matrix is translate-then-rotate, so setting the position after the
  // rotation places the ALREADY-TURNED model - which is what makes measuring it
  // turned the right thing to have done.
  object.position.set(-centre.x, -box.min.y, -centre.z)

  if (!options.noDecimation) {
    await decimate(object, options.decimationTarget)
  }
  downscaleTextures(object, options.textureMaxPx)

  return {
    object,
    // glTF is metres by convention, and the two other formats this catalogue
    // carries were exported the same way. A file that is not is exactly what the
    // model-versus-spec disagreement flag exists to catch.
    widthMm: Math.round(size.x * 1000),
    depthMm: Math.round(size.z * 1000),
    heightMm: Math.round(size.y * 1000),
    triangles: countTriangles(object),
  }
}

export function countTriangles(object: Object3D): number {
  let total = 0
  object.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const geometry = mesh.geometry as BufferGeometry
    const index = geometry.getIndex()
    const position = geometry.getAttribute('position')
    if (index) total += index.count / 3
    else if (position) total += position.count / 3
  })
  return Math.round(total)
}

/**
 * Simplify with meshoptimizer, off the main thread where the browser allows it.
 *
 * Conservative on purpose: the planner camera rarely gets closer than about a
 * metre, and the known ragged edge is thin geometry - mesh chair backs, cable
 * trays. The escape hatch for a model this ruins is the per-file `no_decimation`
 * flag in the admin, not a cleverer heuristic.
 *
 * This saves what the GPU holds, never what the network moved. Nothing shipped
 * in this catalogue is Draco or meshopt compressed, so bytes on the wire are the
 * binding constraint and the only lever on those is a one-off asset pass.
 */
async function decimate(object: Object3D, target: number): Promise<void> {
  if (target >= 1) return
  let simplifier: {
    ready: Promise<void>
    simplify: (
      indices: Uint32Array,
      positions: Float32Array,
      stride: number,
      targetCount: number,
      error: number,
      flags?: string[],
    ) => [Uint32Array, number]
  }
  try {
    const meshopt = await import('meshoptimizer')
    simplifier = meshopt.MeshoptSimplifier as typeof simplifier
    await simplifier.ready
  } catch {
    // Not available in this environment. A model at full detail is a slower
    // planner, not a broken one.
    return
  }

  object.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const geometry = mesh.geometry as BufferGeometry
    const index = geometry.getIndex()
    const position = geometry.getAttribute('position')
    if (!index || !position) return

    const indices = new Uint32Array(index.array as ArrayLike<number>)
    const positions = new Float32Array(position.array as ArrayLike<number>)
    const targetCount = Math.max(3, Math.floor((indices.length * target) / 3) * 3)
    if (targetCount >= indices.length) return

    try {
      const [simplified] = simplifier.simplify(indices, positions, 3, targetCount, 0.01)
      geometry.setIndex(Array.from(simplified))
    } catch {
      // Leave this mesh alone. One awkward geometry must not take the model down.
    }
  })
}

/**
 * Cap texture size before it reaches the GPU.
 *
 * Product-page textures are untouched - this is the planner's own copy, and a
 * room holding a dozen models at full texture resolution is where an integrated
 * GPU gives up. Textures are shared by url across products by the loader beneath
 * us, so a range sharing a finish pays for it once.
 */
function downscaleTextures(object: Object3D, maxPx: number): void {
  const seen = new Set<Texture>()
  object.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh || !mesh.material) return
    const materials: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'] as const) {
        const texture = (material as unknown as Record<string, Texture | null>)[key]
        if (!texture?.image || seen.has(texture)) continue
        seen.add(texture)
        const source = texture.image as CanvasImageSource & { width?: number; height?: number }
        if (!source.width || !source.height) continue
        if (Math.max(source.width, source.height) <= maxPx) continue

        // Actually resample it. This used to set a userData hint and trust three
        // to act on it, which three has never done - so the whole texture budget
        // was a setting the owner could move with no effect whatsoever, and a
        // room of twelve models still arrived at the GPU carrying twelve 4K
        // texture sets.
        const scale = maxPx / Math.max(source.width, source.height)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(source.width * scale))
        canvas.height = Math.max(1, Math.round(source.height * scale))
        const context = canvas.getContext('2d')
        if (!context) continue
        try {
          context.drawImage(source, 0, 0, canvas.width, canvas.height)
        } catch {
          // A source the canvas will not take (a compressed texture, a tainted
          // image). Full detail is a slower planner, not a broken one.
          continue
        }
        texture.image = canvas
        texture.needsUpdate = true
      }
    }
  })
}

/**
 * How far the measured model disagrees with what the catalogue claims, as a
 * fraction. The scene uses this to decide whether to trust the mesh or to scale
 * it to the recorded size - and the admin uses the same idea to flag the file.
 */
export function scaleDrift(measuredMm: number, expectedMm: number): number {
  if (measuredMm <= 0 || expectedMm <= 0) return 0
  return Math.abs(measuredMm - expectedMm) / Math.max(measuredMm, expectedMm)
}
