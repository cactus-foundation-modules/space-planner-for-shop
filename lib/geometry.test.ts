import { describe, expect, it } from 'vitest'
import {
  boundingBox,
  clampItemIntoRoom,
  displacedItems,
  footprintsOverlap,
  heightBandsClash,
  fitOpeningToWall,
  isSelfIntersecting,
  itemCorners,
  itemInsideRoom,
  itemsFight,
  nearestItemGapMm,
  normaliseOrigin,
  normaliseWinding,
  offsetAlongWall,
  perimeterMm,
  pointInPolygon,
  polygonAreaM2,
  polygonSignedArea,
  setWallLength,
  distanceToWallAlong,
  snapToItems,
  snapToWall,
  snapYaw,
  tucksUnder,
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

describe('snapping to other items', () => {
  it('clicks a desk flush against the one beside it', () => {
    const left = item({ id: 'left', x: 1000, y: 1500 })
    // 60 mm short of touching, and 40 mm out of line: both inside the tolerance.
    const right = item({ id: 'right', x: 1000 + 1600 + 60, y: 1540 })
    const snapped = snapToItems(right, [left])
    expect(snapped.x).toBe(left.x + 1600)
    expect(snapped.y).toBe(left.y)
  })

  it('leaves a desk alone when the nearest one is nowhere near', () => {
    const left = item({ id: 'left', x: 500, y: 500 })
    const right = item({ id: 'right', x: 3500, y: 2500 })
    expect(snapToItems(right, [left])).toEqual(right)
  })

  it('does not offer a snap the shopper has escaped with the override key', () => {
    const left = item({ id: 'left', x: 1000, y: 1500 })
    const right = item({ id: 'right', x: 1000 + 1600 + 60, y: 1500 })
    expect(snapToItems(right, [left], 0)).toEqual(right)
  })

  it('snaps to a neighbour stood at a quarter turn, on its real footprint', () => {
    // Turned 90 degrees, so what reads as its width along x is its 800 depth.
    const turned = item({ id: 'turned', x: 1000, y: 1500, yaw: 90 })
    const beside = item({ id: 'beside', x: 1000 + 400 + 800 + 50, y: 1500 })
    expect(snapToItems(beside, [turned]).x).toBe(1000 + 400 + 800)
  })

  it('clicks a chair flush to the front of a desk on the way in', () => {
    const desk = item({ id: 'desk', x: 2000, y: 1500 })
    // Square in front of it, 70 mm short of touching: desk front face is at
    // y = 1900, the chair's back face wants to be there.
    const chair = item({ id: 'chair', widthMm: 650, depthMm: 650, heightMm: 1100, x: 2000, y: 1900 + 325 + 70 })
    expect(snapToItems(chair, [desk]).y).toBe(1900 + 325)
  })

  it('lets a chair carry on under the desk once it is past the edge', () => {
    const desk = item({ id: 'desk', x: 2000, y: 1500 })
    // 100 mm in past the desk's front face, which is INSIDE the 150 mm snap
    // radius on purpose: that is the band where the face offer used to fire and
    // eject the chair straight back out to flush, every pointer event, so a
    // chair could never be pushed under anything. Any deeper than the radius
    // and the offer is out of range and the test proves nothing.
    const under = item({ id: 'chair', widthMm: 650, depthMm: 650, heightMm: 1100, x: 2000, y: 1900 + 325 - 100 })
    expect(snapToItems(under, [desk]).y).toBe(under.y)
  })

  it('still lines an overlapping chair up with the middle of the desk', () => {
    const desk = item({ id: 'desk', x: 2000, y: 1500 })
    // Under the desk and 40 mm off its centre line: the alignments survive the
    // change above, because centring the chair is the other half of tucking it.
    const under = item({ id: 'chair', widthMm: 650, depthMm: 650, heightMm: 1100, x: 2040, y: 1500 })
    expect(snapToItems(under, [desk]).x).toBe(2000)
  })

  it('measures the gap to the nearest thing, and calls touching nothing at all', () => {
    const left = item({ id: 'left', x: 1000, y: 1500 })
    const touching = item({ id: 'touching', x: 1000 + 1600, y: 1500 })
    expect(nearestItemGapMm(touching, [left])).toBe(0)
    expect(nearestItemGapMm(item({ id: 'far', x: 3800, y: 1500 }), [left])).toBeGreaterThan(0)
  })
})

describe('what counts as a clash', () => {
  const desk = item({ id: 'desk', x: 2000, y: 1500, widthMm: 1600, depthMm: 800, heightMm: 730 })
  const chair = item({ id: 'chair', productId: 'chair', x: 2000, y: 1500, widthMm: 650, depthMm: 650, heightMm: 1100 })

  it('does not paint a chair tucked under a desk red', () => {
    expect(itemsFight(chair, desk)).toBe(false)
    expect(itemsFight(desk, chair)).toBe(false)
  })

  it('still paints two desks in the same spot red', () => {
    expect(itemsFight(desk, item({ id: 'other-desk', x: 2100, y: 1500 }))).toBe(true)
  })

  it('believes the catalogue over the guess when the catalogue has an answer', () => {
    const cupboard = item({ id: 'cupboard', productId: 'cupboard', x: 2000, y: 1500, widthMm: 1000, depthMm: 500, heightMm: 900 })
    // Published as having no usable space under it, so nothing goes under it.
    const sizes = { cupboard: { heightMm: null, widthMm: null } }
    expect(tucksUnder(chair, cupboard, sizes)).toBe(false)
  })

  it('will not tuck something wider than the space it is going into', () => {
    const sizes = { p1: { heightMm: 620, widthMm: 1400 } }
    const wide = item({ id: 'wide', productId: 'wide', x: 2000, y: 1500, widthMm: 1500, depthMm: 600, heightMm: 700 })
    expect(tucksUnder(wide, desk, sizes)).toBe(false)
  })

  it('tucks a chair that is deeper than the desk it goes under', () => {
    // The commonest arrangement in this catalogue and the one that used to come
    // up red: chairs are 640-690 deep, half these desks are 600.
    const shallow = item({ id: 'shallow-desk', productId: 'shallow', x: 2000, y: 1500, widthMm: 1400, depthMm: 600, heightMm: 730 })
    const deepChair = item({ id: 'deep-chair', productId: 'deep-chair', x: 2000, y: 1500, widthMm: 675, depthMm: 690, heightMm: 1110 })
    expect(tucksUnder(deepChair, shallow)).toBe(true)
    expect(itemsFight(deepChair, shallow)).toBe(false)
  })

  it('tucks a pedestal under a desk', () => {
    const pedestal = item({ id: 'ped', productId: 'ped', x: 2000, y: 1500, widthMm: 420, depthMm: 600, heightMm: 600 })
    expect(itemsFight(pedestal, desk)).toBe(false)
  })

  it('keeps a chair red against a credenza of desk height, which is solid to the floor', () => {
    // Same height and width as a desk, half the depth. Nothing goes under it.
    const credenza = item({ id: 'credenza', productId: 'credenza', x: 2000, y: 1500, widthMm: 1600, depthMm: 450, heightMm: 730 })
    expect(itemsFight(chair, credenza)).toBe(true)
  })

  it('keeps two desks red even when one is narrower than the other', () => {
    // The narrow one fits the clear width beneath the wide one, and before the
    // worktop-versus-worktop rule that was enough to silence the warning.
    const narrow = item({ id: 'narrow-desk', productId: 'narrow', x: 2050, y: 1500, widthMm: 1400, depthMm: 800, heightMm: 730 })
    expect(itemsFight(narrow, desk)).toBe(true)
  })

  it('keeps a storage tower red against the desk it is standing in', () => {
    const tower = item({ id: 'tower', productId: 'tower', x: 2000, y: 1500, widthMm: 800, depthMm: 450, heightMm: 1800 })
    expect(itemsFight(tower, desk)).toBe(true)
  })
})

describe('doors and windows', () => {
  const geometry: RoomGeometry = { ...defaultRoomGeometry(), vertices: RECT }

  it('measures how far along a wall a point falls', () => {
    expect(offsetAlongWall(RECT, 0, { x: 1000, y: 0 })).toBe(1000)
    // Off the end of the wall gives the end of the wall, not a number off it.
    expect(offsetAlongWall(RECT, 0, { x: 9000, y: 0 })).toBe(4000)
  })

  it('slides an opening back on to the wall when it would hang off the end', () => {
    const fitted = fitOpeningToWall(geometry, {
      id: 'd1', kind: 'door', wallIndex: 0, offsetMm: 3800, widthMm: 900, sillMm: 0, heightMm: 2040,
    })
    expect(fitted?.offsetMm).toBe(4000 - 900)
  })

  it('narrows one that is wider than the wall it is on rather than losing it', () => {
    const narrow: RoomGeometry = {
      ...geometry,
      vertices: [{ x: 0, y: 0 }, { x: 700, y: 0 }, { x: 700, y: 3000 }, { x: 0, y: 3000 }],
    }
    const fitted = fitOpeningToWall(narrow, {
      id: 'd1', kind: 'door', wallIndex: 0, offsetMm: 0, widthMm: 900, sillMm: 0, heightMm: 2040,
    })
    expect(fitted?.widthMm).toBe(700)
    expect(fitted?.offsetMm).toBe(0)
  })

  it('keeps an opening under the ceiling', () => {
    const fitted = fitOpeningToWall(geometry, {
      id: 'w1', kind: 'window', wallIndex: 0, offsetMm: 100, widthMm: 1200, sillMm: 900, heightMm: 4000,
    })
    expect((fitted?.sillMm ?? 0) + (fitted?.heightMm ?? 0)).toBeLessThanOrEqual(geometry.ceilingMm)
  })
})

describe('distanceToWallAlong', () => {
  // The commonest awkward office shape: a 7x3 top leg and a 4x5.5 left leg.
  const L: Vertex[] = [
    { x: 0, y: 0 },
    { x: 7000, y: 0 },
    { x: 7000, y: 3000 },
    { x: 4000, y: 3000 },
    { x: 4000, y: 5500 },
    { x: 0, y: 5500 },
  ]

  it('measures to the wall the ray actually reaches', () => {
    expect(distanceToWallAlong({ x: 2000, y: 1000 }, 0, -1, L)).toBeCloseTo(1000)
    expect(distanceToWallAlong({ x: 2000, y: 1000 }, -1, 0, L)).toBeCloseTo(2000)
  })

  it('stops at the wall of the cut-out rather than at the bounding box', () => {
    // Straight down from the top leg: the floor ends at y = 3000 here, even
    // though the room's bounding box runs to 5500. Measuring to the box was
    // what put a 4.5 m gap beside a desk with a wall 2 m away.
    expect(distanceToWallAlong({ x: 6000, y: 1000 }, 0, 1, L)).toBeCloseTo(2000)
    // And in the other leg, where the box happens to be right, it agrees.
    expect(distanceToWallAlong({ x: 2000, y: 1000 }, 0, 1, L)).toBeCloseTo(4500)
  })

  it('ignores a wall the ray runs alongside rather than into', () => {
    expect(distanceToWallAlong({ x: 2000, y: 0 }, 1, 0, L)).toBeGreaterThan(0)
  })
})
