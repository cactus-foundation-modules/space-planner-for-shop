import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { applyCamera, clampEyeHeight, readCamera, setEyeHeight } from '@/modules/space-planner-for-shop/lib/three/planner-scene'
import { SavedCameraSchema } from '@/modules/space-planner-for-shop/lib/validation'
import type { SceneDescription } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'

// The photograph that came back from an angle nobody had pointed the camera at.
//
// These pin the round trip - stand somewhere, write it down, put it back - and
// the two rules the height control lives by, because both were arrived at by
// getting them wrong first.

function room(ceilingM = 2.4): SceneDescription {
  return {
    units: 'metric',
    floor: { outline: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }], areaM2: 12, finish: 'oak' },
    walls: [],
    wallFinish: 'white',
    obstructions: [],
    ceilingM,
    nodes: [],
    instanceGroups: [],
    centre: { x: 2, z: 1.5 },
    extentM: 4,
  }
}

describe('a viewpoint, written down and put back', () => {
  it('restores the standpoint and what it was looking at', () => {
    const camera = new PerspectiveCamera(50, 1.7, 0.05, 200)
    camera.position.set(1.2, 1.6, 2.8)
    const target = new Vector3(3.5, 1.1, 1.5)
    camera.lookAt(target)

    const saved = readCamera(camera, target)

    // Somewhere else entirely, as it would be by the time anybody asks for the
    // view back.
    const restored = new PerspectiveCamera(50, 1.7, 0.05, 200)
    restored.position.set(-9, 9, -9)
    const back = applyCamera(restored, saved)

    expect(restored.position.x).toBeCloseTo(1.2)
    expect(restored.position.y).toBeCloseTo(1.6)
    expect(restored.position.z).toBeCloseTo(2.8)
    expect(back.x).toBeCloseTo(3.5)
    expect(back.y).toBeCloseTo(1.1)
    expect(back.z).toBeCloseTo(1.5)
  })

  it('survives the jsonb column it is stored in', () => {
    const camera = new PerspectiveCamera(50, 1.7, 0.05, 200)
    camera.position.set(1.2, 1.6, 2.8)
    const saved = readCamera(camera, new Vector3(3.5, 1.1, 1.5))

    // What actually happens: JSON.stringify into jsonb, back out, through zod.
    const parsed = SavedCameraSchema.safeParse(JSON.parse(JSON.stringify(saved)))
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual(saved)
  })

  it('refuses a pose that would render a black frame', () => {
    // Infinity and NaN do not throw in three, they quietly produce nothing - and
    // nothing is a picture somebody paid a machine to take.
    expect(SavedCameraSchema.safeParse({ position: { x: 0, y: Infinity, z: 0 }, target: { x: 0, y: 0, z: 0 } }).success).toBe(false)
    expect(SavedCameraSchema.safeParse({ position: { x: 0, y: Number.NaN, z: 0 }, target: { x: 0, y: 0, z: 0 } }).success).toBe(false)
  })

  it('fills in the lens the planner actually uses when an old record has none', () => {
    const parsed = SavedCameraSchema.parse({ position: { x: 1, y: 1, z: 1 }, target: { x: 2, y: 1, z: 2 } })
    expect(parsed.fov).toBe(50)
    expect(parsed.projection).toBe('perspective')
  })
})

describe('eye height', () => {
  it('keeps the eye inside the room', () => {
    expect(clampEyeHeight(0.05, room())).toBe(0.3)
    expect(clampEyeHeight(99, room(2.4))).toBeCloseTo(2.25)
    expect(clampEyeHeight(Number.NaN, room())).toBeCloseTo(1.6)
  })

  it('moves the camera and what it is looking at by the same amount', () => {
    // The rule the whole control rests on. Moving the camera alone tips the view
    // down as you rise, which is a pitch control - and pitch is already the left
    // mouse button.
    const camera = new PerspectiveCamera(50, 1.7, 0.05, 200)
    camera.position.set(1, 1.2, 1)
    const target = new Vector3(3, 1.2, 1)

    const settled = setEyeHeight(camera, target, 1.7, room())

    expect(settled).toBeCloseTo(1.7)
    expect(camera.position.y).toBeCloseTo(1.7)
    expect(target.y).toBeCloseTo(1.7)
    // Level before, level after: the horizon held.
    expect(target.y - camera.position.y).toBeCloseTo(0)
  })

  it('will not put the eye through the ceiling however hard it is pushed', () => {
    const camera = new PerspectiveCamera(50, 1.7, 0.05, 200)
    camera.position.set(1, 1.6, 1)
    const target = new Vector3(3, 1.6, 1)

    const settled = setEyeHeight(camera, target, 50, room(2.4))

    expect(settled).toBeCloseTo(2.25)
    expect(camera.position.y).toBeCloseTo(2.25)
  })
})
