import { describe, expect, it } from 'vitest'
import {
  boundingBox,
  clampItemIntoRoom,
  displacedItems,
  footprintsOverlap,
  heightBandsClash,
  isSelfIntersecting,
  itemCorners,
  itemInsideRoom,
  normaliseOrigin,
  normaliseWinding,
  perimeterMm,
  pointInPolygon,
  polygonAreaM2,
  polygonSignedArea,
  setWallLength,
  snapToWall,
  snapYaw,
  validateRoomGeometry,
  walls,
} from '@/modules/space-planner-for-shop/lib/geometry'
import { defaultRoomGeometry } from '@/modules/space-planner-for-shop/lib/types'
import type { PlanItem, RoomGeometry, Vertex } from '@/modules/space-planner-for-shop/lib/types'

const RECT: Vertex[] = [
  { x: 0, y: 0 },
  { x: 4000, y: 0 },
  { x: 4000, y: 3000 },
  { x: 0, y: 3000 },
]

function item(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'i1',
    productId: 'p1',
    x: 2000,
    y: 1500,
    z: 0,
    yaw: 0,
    widthMm: 1600,
    depthMm: 800,
    heightMm: 730,
    sizeSource: 'attribute',
    mount: 'floor',
    parentId: null,
    wallIndex: null,
    manualSize: false,
    staged: false,
    ...overrides,
  }
}

describe('polygon basics', () => {
  it('measures area and perimeter', () => {
    expect(polygonAreaM2(RECT)).toBeCloseTo(12)
    expect(perimeterMm(RECT)).toBe(14000)
  })

  it('normalises winding without changing the shape', () => {
    const reversed = [...RECT].reverse()
    expect(polygonSignedArea(reversed)).toBeLessThan(0)
    const fixed = normaliseWinding(reversed)
    expect(polygonSignedArea(fixed)).toBeGreaterThan(0)
    expect(polygonAreaM2(fixed)).toBeCloseTo(12)
  })

  it('moves the outline to the origin', () => {
    const shifted = RECT.map((v) => ({ x: v.x + 1234, y: v.y - 77 }))
    const box = boundingBox(normaliseOrigin(shifted))
    expect(box.minX).toBe(0)
    expect(box.minY).toBe(0)
  })

  it('tells inside from outside', () => {
    expect(pointInPolygon({ x: 2000, y: 1500 }, RECT)).toBe(true)
    expect(pointInPolygon({ x: 5000, y: 1500 }, RECT)).toBe(false)
  })

  it('spots an outline that folds through itself', () => {
    const bowtie: Vertex[] = [
      { x: 0, y: 0 },
      { x: 4000, y: 3000 },
      { x: 4000, y: 0 },
      { x: 0, y: 3000 },
    ]
    expect(isSelfIntersecting(RECT)).toBe(false)
    expect(isSelfIntersecting(bowtie)).toBe(true)
  })
})

describe('setWallLength', () => {
  it('changes only the wall asked for and lets one wall absorb the slack', () => {
    const next = setWallLength(RECT, 0, 5000)
    const wallList = walls(next)
    expect(wallList[0]?.lengthMm).toBeCloseTo(5000)
    // Every other wall keeps its length and direction...
    expect(wallList[1]?.lengthMm).toBeCloseTo(3000)
    expect(wallList[2]?.lengthMm).toBeCloseTo(4000)
    // ...except the one that ends at the anchor, which takes up the slack.
    expect(wallList[3]?.lengthMm).toBeCloseTo(Math.hypot(1000, 3000))
  })

  it('keeps the wall start vertex where it was', () => {
    const next = setWallLength(RECT, 1, 4000)
    expect(next[1]).toEqual(RECT[1])
  })

  it('leaves a degenerate wall alone rather than dividing by zero', () => {
    const degenerate: Vertex[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1000, y: 1000 }]
    expect(setWallLength(degenerate, 0, 2000)).toBe(degenerate)
  })
})

describe('room validation', () => {
  it('passes a plain rectangle', () => {
    expect(validateRoomGeometry(defaultRoomGeometry())).toEqual([])
  })

  it('refuses a room that folds through itself', () => {
    const geometry: RoomGeometry = {
      ...defaultRoomGeometry(),
      vertices: [
        { x: 0, y: 0 },
        { x: 4000, y: 3000 },
        { x: 4000, y: 0 },
        { x: 0, y: 3000 },
      ],
    }
    expect(validateRoomGeometry(geometry).map((i) => i.code)).toContain('self-intersecting')
  })

  it('refuses a hair-thin wall', () => {
    const geometry: RoomGeometry = {
      ...defaultRoomGeometry(),
      vertices: [...RECT, { x: 10, y: 3000 }],
    }
    expect(validateRoomGeometry(geometry).map((i) => i.code)).toContain('wall-too-short')
  })

  it('refuses a door wider than the wall it is on', () => {
    const geometry: RoomGeometry = {
      ...defaultRoomGeometry(),
      openings: [{ id: 'o1', kind: 'door', wallIndex: 1, offsetMm: 200, widthMm: 6000, sillMm: 0, heightMm: 2000 }],
    }
    expect(validateRoomGeometry(geometry).map((i) => i.code)).toContain('opening-too-wide')
  })

  it('refuses an obstruction outside the room', () => {
    const geometry: RoomGeometry = {
      ...defaultRoomGeometry(),
      obstructions: [{
        id: 'ob1',
        label: 'Pillar',
        vertices: [{ x: 9000, y: 9000 }, { x: 9300, y: 9000 }, { x: 9300, y: 9300 }],
        heightMm: 2400,
      }],
    }
    expect(validateRoomGeometry(geometry).map((i) => i.code)).toContain('obstruction-outside')
  })
})

describe('items', () => {
  it('rotates a footprint about its own centre', () => {
    const corners = itemCorners(item({ yaw: 90 }))
    const xs = corners.map((c) => c.x)
    const ys = corners.map((c) => c.y)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(800)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(1600)
  })

  it('sees an overlap and knows when it does not matter', () => {
    const desk = item({ id: 'desk', heightMm: 730 })
    // A chair tucked under a desk overlaps in plan. That is not a clash, it is
    // an office - the height bands are what decide.
    const chairSeat = item({ id: 'chair', x: 2000, y: 1500, widthMm: 600, depthMm: 600, heightMm: 450 })
    expect(footprintsOverlap(desk, chairSeat)).toBe(true)
    expect(heightBandsClash(desk, chairSeat)).toBe(true)

    const pedestal = item({ id: 'ped', x: 2000, y: 1500, widthMm: 400, depthMm: 500, heightMm: 600 })
    const shelf = item({ id: 'shelf', x: 2000, y: 1500, z: 1200, widthMm: 900, depthMm: 300, heightMm: 300 })
    expect(footprintsOverlap(pedestal, shelf)).toBe(true)
    expect(heightBandsClash(pedestal, shelf)).toBe(false)
  })

  it('clamps a stray item back into the room rather than losing it', () => {
    const geometry = defaultRoomGeometry()
    const stray = item({ x: 9000, y: 9000 })
    expect(itemInsideRoom(stray, geometry)).toBe(false)
    const clamped = clampItemIntoRoom(stray, geometry)
    expect(itemInsideRoom(clamped, geometry)).toBe(true)
  })

  it('snaps flat against the nearest wall and faces into the room', () => {
    const geometry = defaultRoomGeometry()
    const near = item({ x: 2000, y: 300 })
    const snapped = snapToWall(near, geometry)
    // Wall 0 runs along y = 0, so the desk's back sits half its depth in.
    expect(snapped.y).toBe(400)
    expect(snapped.yaw).toBeCloseTo(0)
  })

  it('does not snap when the tolerance is switched off', () => {
    const geometry = defaultRoomGeometry()
    const near = item({ x: 2000, y: 300 })
    expect(snapToWall(near, geometry, 0)).toBe(near)
  })

  it('snaps rotation to the step', () => {
    expect(snapYaw(97)).toBe(90)
    expect(snapYaw(97, 0)).toBe(97)
  })
})

describe('displacedItems', () => {
  it('reports what a geometry edit pushed out, and never anything staged', () => {
    const geometry = defaultRoomGeometry()
    const inside = item({ id: 'in' })
    const outside = item({ id: 'out', x: 9000, y: 9000 })
    const staged = item({ id: 'tray', x: 9000, y: 9000, staged: true })
    const displaced = displacedItems([inside, outside, staged], geometry)
    expect(displaced.map((i) => i.id)).toEqual(['out'])
  })

  it('counts an item that a new obstruction now sits on top of', () => {
    const geometry: RoomGeometry = {
      ...defaultRoomGeometry(),
      obstructions: [{
        id: 'ob1',
        label: 'Chimney breast',
        vertices: [
          { x: 1500, y: 1000 },
          { x: 2500, y: 1000 },
          { x: 2500, y: 2000 },
          { x: 1500, y: 2000 },
        ],
        heightMm: 2400,
      }],
    }
    expect(displacedItems([item()], geometry).map((i) => i.id)).toEqual(['i1'])
  })
})
