import { describe, expect, it } from 'vitest'
import { Box3, Mesh } from 'three'
import type { Group, MeshStandardMaterial } from 'three'
import { buildRoom } from '@/modules/space-planner-for-shop/lib/three/planner-scene'
import type { SceneDescription } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'

// The columns that did not render.
//
// A pillar used to be a single flat lid hung at its own height over a hole in
// the floor. Looked at from straight above that is convincing; from anywhere a
// shopper actually stands it is a hairline, and the complaint was that columns
// simply were not there.
//
// So these pin the three things that made it wrong, all of which are the sort
// that come back the next time somebody touches the extrusion: it has to be a
// solid, it has to stand ON the floor rather than hang under it or float over
// it, and it has to be where the plan put it and not mirrored across the room.

function roomWith(obstructions: SceneDescription['obstructions']): SceneDescription {
  return {
    units: 'metric',
    floor: { outline: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }], areaM2: 12, finish: 'oak' },
    walls: [],
    wallFinish: 'white',
    obstructions,
    ceilingM: 2.4,
    nodes: [],
    instanceGroups: [],
    centre: { x: 2, z: 1.5 },
    extentM: 4,
  }
}

/** A 0.4m square column standing away from the middle, so a mirrored z shows up. */
const PILLAR: SceneDescription['obstructions'][number] = {
  id: 'p1',
  label: 'Pillar',
  outline: [{ x: 1, z: 2.2 }, { x: 1.4, z: 2.2 }, { x: 1.4, z: 2.6 }, { x: 1, z: 2.6 }],
  heightM: 2.4,
}

function obstructionMeshes(group: Group): Mesh[] {
  const found: Mesh[] = []
  group.traverse((object) => {
    if (object instanceof Mesh && object.name.startsWith('obstruction:')) found.push(object)
  })
  return found
}

/** The one column in a one-column room. Throws rather than returning undefined,
 *  so a room that drew nothing fails here and not three lines later. */
function onlyColumn(description: SceneDescription): Mesh {
  const [mesh] = obstructionMeshes(buildRoom(description))
  if (!mesh) throw new Error('the room drew no column at all')
  return mesh
}

describe('a column in the 3D room', () => {
  it('is a solid and not a lid', () => {
    expect(obstructionMeshes(buildRoom(roomWith([PILLAR])))).toHaveLength(1)

    const box = new Box3().setFromObject(onlyColumn(roomWith([PILLAR])))
    // A lid has no height at all, which is exactly what this drew before.
    expect(box.max.y - box.min.y).toBeCloseTo(2.4, 5)
    expect(box.max.x - box.min.x).toBeCloseTo(0.4, 5)
    expect(box.max.z - box.min.z).toBeCloseTo(0.4, 5)
  })

  it('stands on the floor rather than under it', () => {
    const box = new Box3().setFromObject(onlyColumn(roomWith([PILLAR])))
    expect(box.min.y).toBeCloseTo(0, 5)
    expect(box.max.y).toBeCloseTo(2.4, 5)
  })

  it('stands where the plan put it, not mirrored across the room', () => {
    const box = new Box3().setFromObject(onlyColumn(roomWith([PILLAR])))
    expect(box.min.x).toBeCloseTo(1, 5)
    expect(box.min.z).toBeCloseTo(2.2, 5)
    expect(box.max.z).toBeCloseTo(2.6, 5)
  })

  it('lets the furniture behind it show through', () => {
    const material = onlyColumn(roomWith([PILLAR])).material as MeshStandardMaterial
    expect(material.transparent).toBe(true)
    expect(material.opacity).toBeGreaterThan(0.5)
    expect(material.opacity).toBeLessThan(1)
  })

  it('leaves the floor whole underneath, so a see-through column is not a view of nothing', () => {
    const room = buildRoom(roomWith([PILLAR]))
    const floor = room.getObjectByName('floor') as Mesh
    const box = new Box3().setFromObject(floor)
    expect(box.min.x).toBeCloseTo(0, 5)
    expect(box.max.x).toBeCloseTo(4, 5)
    expect(box.min.z).toBeCloseTo(0, 5)
    expect(box.max.z).toBeCloseTo(3, 5)
    // Two triangles for a rectangle. A punched-out column would need more.
    expect(floor.geometry.getIndex()?.count).toBe(6)
  })

  it('draws every column in the room', () => {
    const second = { ...PILLAR, id: 'p2', outline: PILLAR.outline.map((point) => ({ x: point.x + 2, z: point.z })) }
    expect(obstructionMeshes(buildRoom(roomWith([PILLAR, second])))).toHaveLength(2)
  })
})
