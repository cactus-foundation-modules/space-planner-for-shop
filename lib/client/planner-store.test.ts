import { describe, expect, it } from 'vitest'
import {
  emptyState,
  findClashes,
  plannerReducer,
  pushHistory,
  redo,
  snapshot,
  toPlanItems,
  underTopFit,
  undo,
} from '@/modules/space-planner-for-shop/lib/client/planner-store'
import type { PlannerState, ProductSize } from '@/modules/space-planner-for-shop/lib/client/planner-store'
import { defaultRoomGeometry } from '@/modules/space-planner-for-shop/lib/types'
import type { PlanItem } from '@/modules/space-planner-for-shop/lib/types'

const desk: ProductSize = {
  productId: 'desk',
  widthMm: 1600,
  depthMm: 800,
  heightMm: 730,
  sizeSource: 'attribute',
  mount: 'floor',
  underTopHeightMm: 620,
  underTopWidthMm: 1400,
}

const pedestal: ProductSize = {
  productId: 'pedestal',
  widthMm: 400,
  depthMm: 500,
  heightMm: 600,
  sizeSource: 'attribute',
  mount: 'floor',
  underTopHeightMm: null,
  underTopWidthMm: null,
}

function start(): PlannerState {
  return emptyState(defaultRoomGeometry())
}

function withDesk(): PlannerState {
  return plannerReducer(start(), { type: 'add-item', id: 'a', product: desk, x: 2000, y: 1500 })
}

describe('adding and moving', () => {
  it('adds an item and selects it', () => {
    const state = withDesk()
    expect(state.items).toHaveLength(1)
    expect(state.selection).toEqual(['a'])
  })

  it('clamps an item dropped outside the room instead of losing it', () => {
    const state = plannerReducer(start(), { type: 'add-item', id: 'a', product: desk, x: 99_000, y: 99_000 })
    const item = state.items[0]
    expect(item).toBeDefined()
    expect(item!.x).toBeLessThan(4000)
  })

  it('takes mounted children along when the parent moves', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 2000, y: 1500 })
    state = plannerReducer(state, { type: 'attach', childId: 'b', parentId: 'a' })
    const before = state.items.find((item) => item.id === 'b')!.x
    state = plannerReducer(state, { type: 'move-items', ids: ['a'], dx: 300, dy: 0, snap: false })
    expect(state.items.find((item) => item.id === 'b')!.x).toBe(before + 300)
  })

  it('lets an item snapped against a wall be dragged away from it', () => {
    // The bug this pins: snapping runs on every pointer event, so a few pixels
    // away from the wall were undone by the very next snap and the item could
    // never accumulate the distance needed to escape. It was welded on.
    let state = withDesk()
    // Push it against the top wall and let the snap take it.
    state = plannerReducer(state, { type: 'move-items', ids: ['a'], dx: 0, dy: -1400, snap: true })
    const stuck = state.items[0]!
    expect(stuck.y).toBeLessThan(500)

    // Now walk it back into the room in realistic drag-sized steps.
    for (let step = 0; step < 12; step++) {
      state = plannerReducer(state, { type: 'move-items', ids: ['a'], dx: 0, dy: 40, snap: true })
    }
    expect(state.items[0]!.y).toBeGreaterThan(stuck.y + 400)
  })

  it('still snaps an item to the wall it is being dragged towards', () => {
    let state = withDesk()
    for (let step = 0; step < 10; step++) {
      state = plannerReducer(state, { type: 'move-items', ids: ['a'], dx: 0, dy: -120, snap: true })
    }
    // Flush: the centre sits half the item's depth off the wall.
    expect(state.items[0]!.y).toBeCloseTo(desk.depthMm / 2, 0)
  })

  it('refuses to nest one accessory under another', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 2000, y: 1500 })
    state = plannerReducer(state, { type: 'add-item', id: 'c', product: pedestal, x: 2200, y: 1500 })
    state = plannerReducer(state, { type: 'attach', childId: 'b', parentId: 'a' })
    state = plannerReducer(state, { type: 'attach', childId: 'c', parentId: 'b' })
    expect(state.items.find((item) => item.id === 'c')!.parentId).toBeNull()
  })
})

describe('deleting', () => {
  it('detaches a child rather than deleting it with its parent', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 2000, y: 1500 })
    state = plannerReducer(state, { type: 'attach', childId: 'b', parentId: 'a' })
    state = plannerReducer(state, { type: 'delete-items', ids: ['a'] })
    const survivor = state.items.find((item) => item.id === 'b')
    expect(survivor).toBeDefined()
    expect(survivor!.parentId).toBeNull()
  })
})

describe('repetition', () => {
  it('arrays a desk along a wall', () => {
    let state = withDesk()
    state = plannerReducer(state, {
      type: 'array-item',
      id: 'a',
      count: 2,
      spacingMm: 900,
      alongYaw: 0,
      newIds: ['b', 'c'],
    })
    expect(state.items).toHaveLength(3)
    expect(state.selection).toEqual(['b', 'c'])
  })

  it('duplicates a selection', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'duplicate-items', ids: ['a'], offsetMm: 200, newIds: ['b'] })
    expect(state.items.map((item) => item.id)).toEqual(['a', 'b'])
  })
})

describe('bulk variant replace', () => {
  it('swaps the product and its size across a selection', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: desk, x: 1000, y: 1000 })
    const oak: ProductSize = { ...desk, productId: 'desk-oak', widthMm: 1800 }
    state = plannerReducer(state, { type: 'replace-product', ids: ['a', 'b'], product: oak })
    expect(state.items.every((item) => item.productId === 'desk-oak')).toBe(true)
    expect(state.items.every((item) => item.widthMm === 1800)).toBe(true)
  })

  it('leaves a size the shopper typed alone', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'set-item', id: 'a', patch: { widthMm: 2000, manualSize: true } })
    const oak: ProductSize = { ...desk, productId: 'desk-oak', widthMm: 1800 }
    state = plannerReducer(state, { type: 'replace-product', ids: ['a'], product: oak })
    expect(state.items[0]!.widthMm).toBe(2000)
  })
})

describe('staging tray', () => {
  it('moves items to the tray without deleting them, and back out again', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'stage-items', ids: ['a'] })
    expect(state.items[0]!.staged).toBe(true)
    state = plannerReducer(state, { type: 'unstage-item', id: 'a', x: 1500, y: 1200 })
    expect(state.items[0]!.staged).toBe(false)
  })

  it('leaves a staged item out of the plan sent to the server', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 1000, y: 1000, staged: true })
    const plan = toPlanItems(state)
    expect(plan.items.filter((item) => !item.staged)).toHaveLength(1)
  })
})

describe('clash detection', () => {
  it('says nothing about a chair tucked under a desk', () => {
    const items: PlanItem[] = [
      { ...withDesk().items[0]!, id: 'desk' },
      { ...withDesk().items[0]!, id: 'shelf', z: 1200, heightMm: 300, depthMm: 300 },
    ]
    expect(findClashes(items)).toEqual([])
  })

  it('reports two floor items in the same place', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: desk, x: 2000, y: 1500 })
    expect(findClashes(state.items)).toHaveLength(1)
  })
})

describe('underTopFit', () => {
  it('answers the pedestal question, and says nothing when it cannot', () => {
    const short = { ...withDesk().items[0]!, heightMm: 600 }
    const tall = { ...withDesk().items[0]!, heightMm: 700 }
    expect(underTopFit(short, { heightMm: 620, widthMm: null })?.fits).toBe(true)
    expect(underTopFit(tall, { heightMm: 620, widthMm: null })?.fits).toBe(false)
    expect(underTopFit(tall, { heightMm: null, widthMm: null })).toBeNull()
  })
})

describe('undo', () => {
  it('rewinds and replays', () => {
    const first = withDesk()
    let history = pushHistory({ past: [], future: [] }, first)
    const second = plannerReducer(first, { type: 'move-items', ids: ['a'], dx: 300, dy: 0, snap: false })

    const undone = undo(history, second)
    expect(undone).not.toBeNull()
    expect(undone!.snapshot.items[0]!.x).toBe(first.items[0]!.x)

    history = undone!.history
    const restored: PlannerState = { ...second, ...undone!.snapshot }
    const redone = redo(history, restored)
    expect(redone).not.toBeNull()
    expect(redone!.snapshot.items[0]!.x).toBe(second.items[0]!.x)
  })

  it('has nothing to undo at the start', () => {
    expect(undo({ past: [], future: [] }, start())).toBeNull()
  })

  it('keeps snapshots independent of later edits', () => {
    const first = withDesk()
    const snap = snapshot(first)
    const second = plannerReducer(first, { type: 'move-items', ids: ['a'], dx: 500, dy: 0, snap: false })
    expect(snap.items[0]!.x).not.toBe(second.items[0]!.x)
  })
})

describe('room geometry', () => {
  it('moves the outline back to the origin after a wall length change', () => {
    const state = plannerReducer(withDesk(), { type: 'set-wall-length', wallIndex: 0, lengthMm: 6000 })
    const xs = state.geometry.vertices.map((v) => v.x)
    const ys = state.geometry.vertices.map((v) => v.y)
    expect(Math.min(...xs)).toBe(0)
    expect(Math.min(...ys)).toBe(0)
  })
})
