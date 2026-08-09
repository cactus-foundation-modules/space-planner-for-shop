import { describe, expect, it } from 'vitest'
import { buildScene, plainUrl, uniqueModelCount } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { ResolvedModel } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import { defaultRoomGeometry } from '@/modules/space-planner-for-shop/lib/types'
import type { PlanItem, PlanItems, ProductSnapshot } from '@/modules/space-planner-for-shop/lib/types'

function item(id: string, productId: string, overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    productId,
    x: 1000,
    y: 1000,
    z: 0,
    yaw: 0,
    widthMm: 1600,
    depthMm: 800,
    heightMm: 730,
    sizeSource: 'glb',
    mount: 'floor',
    parentId: null,
    wallIndex: null,
    manualSize: false,
    staged: false,
    modelContext: null,
    basketLine: null,
    basketBundle: null,
    ...overrides,
  }
}

const snapshot: ProductSnapshot = {
  desk: { name: 'Impulse Desk', sku: 'IMP-1600', slug: 'impulse-desk', price: 249, taxClassId: null, image: '/img/desk.webp', parentId: null, optionSummary: 'Oak' },
  chair: { name: 'Eclipse Chair', sku: 'ECL-1', slug: 'eclipse-chair', price: 189, taxClassId: null, image: null, parentId: null, optionSummary: '' },
}

const deskModel: ResolvedModel = { productId: 'desk', plainUrl: 'https://cdn/desk.glb', format: 'glb', yawOffsetDeg: 0, noDecimation: false, fabricKey: '' }

describe('buildScene', () => {
  const plan: PlanItems = {
    version: 1,
    items: [
      item('a', 'desk'),
      item('b', 'desk', { x: 3000 }),
      item('c', 'chair', { widthMm: 600, depthMm: 600, heightMm: 1100, sizeSource: 'category_default' }),
      item('tray', 'chair', { staged: true }),
    ],
  }

  const scene = buildScene(defaultRoomGeometry(), plan, snapshot, new Map([['desk', deskModel]]))

  it('leaves staged items out of the room', () => {
    expect(scene.nodes.map((n) => n.itemId)).toEqual(['a', 'b', 'c'])
  })

  it('converts millimetres to metres and plan y to world z', () => {
    const node = scene.nodes[0]
    expect(node?.position).toEqual({ x: 1, y: 0, z: 1 })
    expect(node?.size).toEqual({ width: 1.6, depth: 0.8, height: 0.73 })
  })

  it('negates yaw exactly once, going from plan to world', () => {
    const rotated = buildScene(defaultRoomGeometry(), { version: 1, items: [item('a', 'desk', { yaw: 90 })] }, snapshot, new Map())
    expect(rotated.nodes[0]?.rotationY).toBeCloseTo(-Math.PI / 2)
  })

  it('groups the two identical desks onto one model file', () => {
    expect(uniqueModelCount(scene)).toBe(1)
    expect(scene.instanceGroups[0]?.itemIds).toEqual(['a', 'b'])
  })

  it('keeps two colours of the same file apart', () => {
    // One chair file, painted at view time. Grouped on the file alone, a room
    // holding a blue one and a black one drew whichever was resolved first,
    // twice - and neither shopper got the chair they picked.
    const models = new Map<string, ResolvedModel>([
      ['desk', deskModel],
      ['chair', { productId: 'chair', plainUrl: 'https://cdn/chair.glb', format: 'glb', yawOffsetDeg: 0, noDecimation: false, fabricKey: 'blue1' }],
    ])
    const twoColours = buildScene(
      defaultRoomGeometry(),
      { version: 1, items: [item('a', 'desk'), item('c', 'chair')] },
      snapshot,
      models,
    )
    expect(twoColours.instanceGroups).toHaveLength(2)
    expect(twoColours.instanceGroups.find((group) => group.fabricKey === 'blue1')?.key).toBe('https://cdn/chair.glb::blue1')
  })

  it('marks a category-default size as approximate', () => {
    expect(scene.nodes.find((n) => n.itemId === 'c')?.approximate).toBe(true)
    expect(scene.nodes.find((n) => n.itemId === 'a')?.approximate).toBe(false)
  })

  it('gives an unmodelled product no model, so it draws as a placeholder', () => {
    expect(scene.nodes.find((n) => n.itemId === 'c')?.model).toBeNull()
  })

  it('carries the room outline, walls and area through', () => {
    expect(scene.floor.areaM2).toBeCloseTo(12)
    expect(scene.floor.outline).toHaveLength(4)
    expect(scene.walls).toHaveLength(4)
    expect(scene.ceilingM).toBeCloseTo(2.4)
  })

  it('labels from the snapshot, so a retired product still reads as itself', () => {
    expect(scene.nodes[0]?.label).toBe('Impulse Desk')
  })
})

describe('plainUrl', () => {
  it('strips the signature so one file is one download', () => {
    expect(plainUrl('https://cdn/desk.glb?token=abc&exp=1')).toBe('https://cdn/desk.glb')
    expect(plainUrl('https://cdn/desk.glb')).toBe('https://cdn/desk.glb')
  })
})
