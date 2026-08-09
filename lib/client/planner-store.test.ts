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
import { boundingBox, displacedItems } from '@/modules/space-planner-for-shop/lib/geometry'
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

  it('keeps a child with its parent when the parent snaps to a wall', () => {
    // The parent's snap can add a quarter-metre of wall pull that the raw drag
    // knew nothing about. The child used to get the raw drag, so a desk that
    // snapped flush left its pedestal behind wherever the finger had been.
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 2000, y: 1500 })
    state = plannerReducer(state, { type: 'attach', childId: 'b', parentId: 'a' })
    const deskBefore = state.items.find((item) => item.id === 'a')!
    const childBefore = state.items.find((item) => item.id === 'b')!
    const gapX = childBefore.x - deskBefore.x
    const gapY = childBefore.y - deskBefore.y

    state = plannerReducer(state, { type: 'move-items', ids: ['a'], dx: 0, dy: -1400, snap: true })

    const deskAfter = state.items.find((item) => item.id === 'a')!
    const childAfter = state.items.find((item) => item.id === 'b')!
    // The snap really did pull it further than the drag asked for.
    expect(deskAfter.y).toBeGreaterThan(childBefore.y - 1400)
    // And the pedestal is still exactly where it was relative to the desk.
    expect(childAfter.x - deskAfter.x).toBe(gapX)
    expect(childAfter.y - deskAfter.y).toBe(gapY)
  })

  it('moves a multi-select of unrelated items by the same amount', () => {
    // Moving is done in two passes now (parents, then their children against
    // what the parent actually did), so the ordinary case of several unrelated
    // things dragged together has to be pinned as well. Both are kept well
    // clear of the walls: an item against one cannot move further into it, and
    // that clamp would otherwise read as a bug in the pass.
    let state = plannerReducer(start(), { type: 'add-item', id: 'a', product: pedestal, x: 1200, y: 1200 })
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 2600, y: 1800 })
    const before = new Map(state.items.map((item) => [item.id, { x: item.x, y: item.y }]))

    state = plannerReducer(state, { type: 'move-items', ids: ['a', 'b'], dx: 100, dy: 50, snap: false })

    for (const item of state.items) {
      expect(item.x).toBe(before.get(item.id)!.x + 100)
      expect(item.y).toBe(before.get(item.id)!.y + 50)
    }
  })

  it('moves a child exactly once when it is selected alongside its parent', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 2000, y: 1600 })
    state = plannerReducer(state, { type: 'attach', childId: 'b', parentId: 'a' })
    const before = new Map(state.items.map((item) => [item.id, item.x]))

    state = plannerReducer(state, { type: 'move-items', ids: ['a', 'b'], dx: 150, dy: 0, snap: false })

    for (const item of state.items) expect(item.x).toBe(before.get(item.id)! + 150)
  })

  it('moves a child dragged on its own without dragging its parent', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 2100, y: 1500 })
    state = plannerReducer(state, { type: 'attach', childId: 'b', parentId: 'a' })
    const parentBefore = state.items.find((item) => item.id === 'a')!.x
    const childBefore = state.items.find((item) => item.id === 'b')!.x

    state = plannerReducer(state, { type: 'move-items', ids: ['b'], dx: 120, dy: 0, snap: false })

    expect(state.items.find((item) => item.id === 'b')!.x).toBe(childBefore + 120)
    expect(state.items.find((item) => item.id === 'a')!.x).toBe(parentBefore)
  })

  it('refuses to nest one accessory under another', () => {
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 2000, y: 1500 })
    state = plannerReducer(state, { type: 'add-item', id: 'c', product: pedestal, x: 2200, y: 1500 })
    state = plannerReducer(state, { type: 'attach', childId: 'b', parentId: 'a' })
    state = plannerReducer(state, { type: 'attach', childId: 'c', parentId: 'b' })
    expect(state.items.find((item) => item.id === 'c')!.parentId).toBeNull()
  })

  it('refuses to nest from the other end either', () => {
    // A child that already has children of its own cannot become somebody's
    // child: that builds the same two-level chain the test above refuses,
    // approached from the opposite direction.
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 2000, y: 1500 })
    state = plannerReducer(state, { type: 'add-item', id: 'c', product: desk, x: 2600, y: 1500 })
    state = plannerReducer(state, { type: 'attach', childId: 'b', parentId: 'a' })
    state = plannerReducer(state, { type: 'attach', childId: 'a', parentId: 'c' })
    expect(state.items.find((item) => item.id === 'a')!.parentId).toBeNull()
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

describe('turning things round', () => {
  // The save schema tops out at 3600 degrees and nothing wrapped the angle, so
  // it only ever grew: forty-one presses of "Turn 90°", or one typed 99999, and
  // EVERY later save was refused - with the bad value in the browser's scratch
  // copy, so reloading did not clear it either.
  it('keeps the angle inside one turn however many times it is turned', () => {
    let state = withDesk()
    for (let press = 0; press < 50; press += 1) {
      state = plannerReducer(state, { type: 'rotate-items', ids: ['a'], deltaDeg: 90, snap: true })
    }
    const yaw = state.items[0]!.yaw
    expect(yaw).toBeGreaterThanOrEqual(0)
    expect(yaw).toBeLessThan(360)
  })

  it('wraps an angle typed straight into the properties panel', () => {
    const state = plannerReducer(withDesk(), { type: 'set-item', id: 'a', patch: { yaw: 99999 } })
    expect(state.items[0]!.yaw).toBe(99999 % 360)
  })

  it('turns anticlockwise without going negative', () => {
    const state = plannerReducer(withDesk(), { type: 'rotate-items', ids: ['a'], deltaDeg: -90, snap: true })
    expect(state.items[0]!.yaw).toBe(270)
  })

  it('reads a nonsense angle as no rotation rather than storing it', () => {
    const state = plannerReducer(withDesk(), { type: 'set-item', id: 'a', patch: { yaw: Number.NaN } })
    expect(state.items[0]!.yaw).toBe(0)
  })
})

describe('emptying the waiting list', () => {
  // "Refresh from basket" clears the tray and reads the basket again. The ids
  // cannot be worked out by the caller: it reads the basket over the network
  // first, and anything the shopper places while that request is in flight is
  // no longer waiting by the time the clear lands.
  function trayAndRoom(): PlannerState {
    let state = plannerReducer(start(), { type: 'add-item', id: 'placed', product: desk, x: 1200, y: 1200 })
    state = plannerReducer(state, { type: 'add-item', id: 'waiting1', product: pedestal, x: 0, y: 0, staged: true })
    return plannerReducer(state, { type: 'add-item', id: 'waiting2', product: pedestal, x: 0, y: 0, staged: true })
  }

  it('takes everything waiting and nothing that is in the room', () => {
    const after = plannerReducer(trayAndRoom(), { type: 'clear-staged' })
    expect(after.items.map((item) => item.id)).toEqual(['placed'])
  })

  it('leaves an item placed from the tray a moment ago alone', () => {
    // The bug this pins: the ids were read off the caller's copy of the state,
    // so an item placed during the fetch was still listed as waiting and the
    // refresh took it back out of the room.
    let state = trayAndRoom()
    state = plannerReducer(state, { type: 'unstage-item', id: 'waiting1', x: 2000, y: 2000 })

    const after = plannerReducer(state, { type: 'clear-staged' })

    expect(after.items.map((item) => item.id).sort()).toEqual(['placed', 'waiting1'])
    expect(after.items.find((item) => item.id === 'waiting1')!.staged).toBe(false)
  })

  it('drops a cleared item out of the selection rather than leaving it dangling', () => {
    let state = trayAndRoom()
    state = plannerReducer(state, { type: 'select', ids: ['placed', 'waiting1'] })
    const after = plannerReducer(state, { type: 'clear-staged' })
    expect(after.selection).toEqual(['placed'])
  })

  it('is a no-op when nothing is waiting', () => {
    const state = plannerReducer(start(), { type: 'add-item', id: 'a', product: desk, x: 1200, y: 1200 })
    expect(plannerReducer(state, { type: 'clear-staged' })).toBe(state)
  })
})

describe('what a room edit displaces', () => {
  // The reducer and the room route have to agree about this. They did not: the
  // reducer asked only whether an item was still inside the walls, so a column
  // dropped on a desk left the desk standing in it - and because the client's
  // answer is written over the server's on the next save, the one plan where
  // the promise failed was the one on screen.
  function deskWithPedestal(): PlannerState {
    let state = withDesk()
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 2000, y: 1500 })
    return plannerReducer(state, { type: 'attach', childId: 'b', parentId: 'a' })
  }

  const columnOverTheDesk = (state: PlannerState) => ({
    ...state.geometry,
    obstructions: [
      {
        id: 'col',
        label: 'Column',
        heightMm: 2400,
        vertices: [
          { x: 1900, y: 1400 },
          { x: 2100, y: 1400 },
          { x: 2100, y: 1600 },
          { x: 1900, y: 1600 },
        ],
      },
    ],
  })

  it('stages a desk left standing inside a column', () => {
    const state = deskWithPedestal()
    const after = plannerReducer(state, { type: 'set-geometry', geometry: columnOverTheDesk(state) })
    expect(after.items.find((item) => item.id === 'a')!.staged).toBe(true)
  })

  it('agrees with the room route about which items those are', () => {
    const state = deskWithPedestal()
    const geometry = columnOverTheDesk(state)
    const server = displacedItems(state.items, geometry).map((item) => item.id)
    const after = plannerReducer(state, { type: 'set-geometry', geometry })
    // The server names the parent; the client stages the parent and takes its
    // child with it, which is the same answer expressed on the item list.
    expect(server).toContain('a')
    for (const id of server) expect(after.items.find((item) => item.id === id)!.staged).toBe(true)
  })

  // Through the actions the column controls actually dispatch. A test that goes
  // via set-geometry proves nothing about these: the toolbar never dispatches
  // it, and all three of these skipped the displacement rule entirely - so the
  // desk stayed inside the pillar on screen while saving moved the furniture in
  // every OTHER layout in the room, which is the wrong way round twice over.
  describe('putting a column where furniture is standing', () => {
    const overTheDesk = { x: 2000, y: 1500 }

    function deskAt(x: number, y: number): PlannerState {
      return plannerReducer(start(), { type: 'add-item', id: 'a', product: desk, x, y })
    }

    it('stages the desk when a column is dropped on it', () => {
      const state = deskAt(overTheDesk.x, overTheDesk.y)
      const after = plannerReducer(state, {
        type: 'add-obstruction',
        id: 'col',
        x: overTheDesk.x,
        y: overTheDesk.y,
        widthMm: 300,
        depthMm: 300,
        heightMm: 2400,
        label: 'Column',
      })
      expect(after.items.find((item) => item.id === 'a')!.staged).toBe(true)
    })

    it('stages the desk when a column is dragged onto it and let go', () => {
      let state = deskAt(overTheDesk.x, overTheDesk.y)
      state = plannerReducer(state, {
        type: 'add-obstruction', id: 'col', x: 200, y: 200, widthMm: 300, depthMm: 300, heightMm: 2400, label: 'Column',
      })
      expect(state.items.find((item) => item.id === 'a')!.staged).toBe(false)

      state = plannerReducer(state, {
        type: 'move-obstruction', id: 'col', dx: overTheDesk.x - 200, dy: overTheDesk.y - 200,
      })
      const after = plannerReducer(state, { type: 'move-obstruction', id: 'col', dx: 0, dy: 0, settle: true })
      expect(after.items.find((item) => item.id === 'a')!.staged).toBe(true)
    })

    it('does not sweep up every desk a column is dragged past', () => {
      // A drag arrives as a stream of pointer moves. Judging the furniture on
      // each one meant a column dragged across the room took everything it
      // passed over onto the waiting list, and dragging it back did not bring
      // any of it home. Only where it is PUT DOWN counts.
      // Two desks with a gap between them, and the column parked in the gap.
      let state = plannerReducer(start(), { type: 'add-item', id: 'left', product: desk, x: 900, y: 1500 })
      state = plannerReducer(state, { type: 'add-item', id: 'right', product: desk, x: 3100, y: 1500 })
      state = plannerReducer(state, {
        type: 'add-obstruction', id: 'col', x: 2000, y: 1500, widthMm: 300, depthMm: 300, heightMm: 2400, label: 'Column',
      })
      expect(state.items.every((item) => !item.staged)).toBe(true)

      // Dragged left THROUGH the left desk, then back across and put down on the
      // right one. Only the desk it is left standing in should be staged.
      for (let step = 0; step < 10; step += 1) {
        state = plannerReducer(state, { type: 'move-obstruction', id: 'col', dx: -110, dy: 0 })
      }
      for (let step = 0; step < 20; step += 1) {
        state = plannerReducer(state, { type: 'move-obstruction', id: 'col', dx: 110, dy: 0 })
      }
      const after = plannerReducer(state, { type: 'move-obstruction', id: 'col', dx: 0, dy: 0, settle: true })

      expect(after.items.find((item) => item.id === 'left')!.staged).toBe(false)
      expect(after.items.find((item) => item.id === 'right')!.staged).toBe(true)
    })

    it('stages the desk when a column is widened into it', () => {
      let state = deskAt(overTheDesk.x, overTheDesk.y)
      state = plannerReducer(state, {
        type: 'add-obstruction', id: 'col', x: overTheDesk.x + 1400, y: overTheDesk.y, widthMm: 200, depthMm: 200, heightMm: 2400, label: 'Column',
      })
      expect(state.items.find((item) => item.id === 'a')!.staged).toBe(false)

      const after = plannerReducer(state, {
        type: 'set-obstruction', id: 'col', patch: { widthMm: 2400 },
      })
      expect(after.items.find((item) => item.id === 'a')!.staged).toBe(true)
    })

    it('leaves a desk already standing in one column alone when another is edited', () => {
      // Standing a desk in a column is legal - the planner warns rather than
      // blocks - so an item can already be there when a second column is dropped
      // in a far corner or the first is simply renamed. Staging everything
      // currently displaced meant an edit over here took furniture out of the
      // room over there, with no message and nothing to explain it.
      let state = deskAt(overTheDesk.x, overTheDesk.y)
      state = plannerReducer(state, {
        type: 'add-obstruction', id: 'colA', x: 200, y: 200, widthMm: 300, depthMm: 300, heightMm: 2400, label: 'A',
      })
      // Dragged onto colA deliberately, which is allowed and warned about.
      state = plannerReducer(state, { type: 'move-items', ids: ['a'], dx: 200 - overTheDesk.x, dy: 200 - overTheDesk.y, snap: false })
      state = plannerReducer(state, { type: 'set-item', id: 'a', patch: { staged: false } })
      expect(state.items.find((item) => item.id === 'a')!.staged).toBe(false)

      const renamed = plannerReducer(state, { type: 'set-obstruction', id: 'colA', patch: { label: 'Pillar' } })
      expect(renamed.items.find((item) => item.id === 'a')!.staged).toBe(false)

      const second = plannerReducer(state, {
        type: 'add-obstruction', id: 'colB', x: 3400, y: 2600, widthMm: 300, depthMm: 300, heightMm: 2400, label: 'B',
      })
      expect(second.items.find((item) => item.id === 'a')!.staged).toBe(false)
    })

    it('leaves furniture alone when the column lands in clear floor', () => {
      const state = deskAt(overTheDesk.x, overTheDesk.y)
      const after = plannerReducer(state, {
        type: 'add-obstruction', id: 'col', x: 400, y: 2600, widthMm: 300, depthMm: 300, heightMm: 2400, label: 'Column',
      })
      expect(after.items.find((item) => item.id === 'a')!.staged).toBe(false)
    })
  })

  it('rescues a child left outside a shrunken room even when its parent still fits', () => {
    // displacedItems judges a child by its parent, which is right when the
    // parent MOVES. Reshaping the room is the case it is wrong for: pull a wall
    // in far enough and the desk still fits while the pedestal behind it does
    // not, and nothing was staging the pedestal - it stayed placed, outside the
    // walls, still attached to something inside them.
    let state = plannerReducer(start(), { type: 'add-item', id: 'a', product: desk, x: 1000, y: 1000 })
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 1000, y: 2600 })
    state = plannerReducer(state, { type: 'attach', childId: 'b', parentId: 'a' })

    const parentBefore = state.items.find((item) => item.id === 'a')!
    const childBefore = state.items.find((item) => item.id === 'b')!
    expect(parentBefore.staged).toBe(false)
    expect(childBefore.staged).toBe(false)

    // A room that still holds the desk and no longer reaches the pedestal.
    const shrunk = {
      ...state.geometry,
      vertices: [
        { x: 0, y: 0 },
        { x: 2200, y: 0 },
        { x: 2200, y: 2000 },
        { x: 0, y: 2000 },
      ],
    }
    const after = plannerReducer(state, { type: 'set-geometry', geometry: shrunk })

    expect(after.items.find((item) => item.id === 'b')!.staged).toBe(true)
    expect(after.items.find((item) => item.id === 'b')!.parentId).toBeNull()
  })

  it('leaves a child alone when the whole family still fits', () => {
    let state = plannerReducer(start(), { type: 'add-item', id: 'a', product: desk, x: 1500, y: 1200 })
    state = plannerReducer(state, { type: 'add-item', id: 'b', product: pedestal, x: 1500, y: 1600 })
    state = plannerReducer(state, { type: 'attach', childId: 'b', parentId: 'a' })

    const after = plannerReducer(state, { type: 'set-geometry', geometry: state.geometry })

    expect(after.items.every((item) => !item.staged)).toBe(true)
    expect(after.items.find((item) => item.id === 'b')!.parentId).toBe('a')
  })

  it('takes a mounted child onto the waiting list with its parent', () => {
    const state = deskWithPedestal()
    const after = plannerReducer(state, { type: 'set-geometry', geometry: columnOverTheDesk(state) })
    const child = after.items.find((item) => item.id === 'b')!
    expect(child.staged).toBe(true)
    expect(child.parentId).toBeNull()
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

describe('turning things', () => {
  function deskWithArm(): PlannerState {
    const withParent = plannerReducer(start(), { type: 'add-item', id: 'desk', product: desk, x: 2000, y: 1500 })
    const withChild = plannerReducer(withParent, { type: 'add-item', id: 'arm', product: pedestal, x: 2000, y: 1200 })
    return plannerReducer(withChild, { type: 'attach', childId: 'arm', parentId: 'desk' })
  }

  it('brings whatever is mounted on an item round with it', () => {
    const state = plannerReducer(deskWithArm(), { type: 'rotate-items', ids: ['desk'], deltaDeg: 90, snap: false })
    const parent = state.items.find((item) => item.id === 'desk')
    const child = state.items.find((item) => item.id === 'arm')
    expect(parent?.yaw).toBe(90)
    expect(child?.yaw).toBe(90)
    // The arm was 300 mm in front of the desk's centre; a quarter turn puts it
    // 300 mm to one side of it, not where it was.
    expect(child?.x).toBe(2300)
    expect(child?.y).toBe(1500)
  })

  it('turns a child by what the parent actually did, not by what was asked for', () => {
    const spun = plannerReducer(deskWithArm(), { type: 'rotate-items', ids: ['desk'], deltaDeg: 7, snap: true })
    const parent = spun.items.find((item) => item.id === 'desk')
    const child = spun.items.find((item) => item.id === 'arm')
    // Snapped to nothing at all, so the arm must not have moved either.
    expect(parent?.yaw).toBe(0)
    expect(child?.yaw).toBe(0)
    expect(child?.x).toBe(2000)
  })
})

describe('doors and windows', () => {
  it('puts a door on the wall centred on where it was tapped', () => {
    const state = plannerReducer(start(), { type: 'add-opening', id: 'd1', kind: 'door', wallIndex: 0, offsetMm: 2000 })
    const opening = state.geometry.openings[0]
    expect(opening?.kind).toBe('door')
    expect(opening?.widthMm).toBe(900)
    expect(opening?.offsetMm).toBe(2000 - 450)
  })

  it('keeps one on its wall when it is slid past the end', () => {
    const added = plannerReducer(start(), { type: 'add-opening', id: 'd1', kind: 'door', wallIndex: 0, offsetMm: 2000 })
    const slid = plannerReducer(added, { type: 'set-opening', id: 'd1', patch: { offsetMm: 9000 } })
    expect(slid.geometry.openings[0]?.offsetMm).toBe(4000 - 900)
  })

  it('slides a door along when the wall it is on is shortened', () => {
    const added = plannerReducer(start(), { type: 'add-opening', id: 'd1', kind: 'door', wallIndex: 0, offsetMm: 3500 })
    expect(added.geometry.openings[0]?.offsetMm).toBe(3050)
    const shortened = plannerReducer(added, { type: 'set-wall-length', wallIndex: 0, lengthMm: 2000 })
    const opening = shortened.geometry.openings[0]
    expect(opening).toBeDefined()
    expect(opening!.offsetMm + opening!.widthMm).toBeLessThanOrEqual(2000)
  })

  it('removes one on request', () => {
    const added = plannerReducer(start(), { type: 'add-opening', id: 'd1', kind: 'door', wallIndex: 0, offsetMm: 2000 })
    expect(plannerReducer(added, { type: 'delete-opening', id: 'd1' }).geometry.openings).toEqual([])
  })
})

describe('clash warnings', () => {
  it('says nothing about a chair pushed under a desk', () => {
    const chair: ProductSize = {
      productId: 'chair',
      widthMm: 650,
      depthMm: 650,
      heightMm: 1100,
      sizeSource: 'attribute',
      mount: 'floor',
      underTopHeightMm: null,
      underTopWidthMm: null,
    }
    const state = plannerReducer(withDesk(), { type: 'add-item', id: 'chair', product: chair, x: 2000, y: 1500 })
    const sizes = { desk: { heightMm: 620, widthMm: 1400 } }
    expect(findClashes(state.items, sizes)).toEqual([])
  })

  it('still says something about two desks in one place', () => {
    const state = plannerReducer(withDesk(), { type: 'add-item', id: 'b', product: desk, x: 2000, y: 1500 })
    const moved = plannerReducer(state, { type: 'set-item', id: 'b', patch: { x: 2000, y: 1500 } })
    expect(findClashes(moved.items, { desk: { heightMm: 620, widthMm: 1400 } })).toHaveLength(1)
  })
})

/**
 * What the keyboard now reaches.
 *
 * A door's position along its wall and a column's position on the floor had no
 * control at all - both were drag-only, so without a pointer they could be made
 * and sized but never put anywhere. The bars now type into the two actions
 * below, and these are the values those boxes hand over, nought included.
 */
describe('positions typed rather than dragged', () => {
  it('slides a door along its wall to a typed offset', () => {
    const added = plannerReducer(start(), { type: 'add-opening', id: 'd1', kind: 'door', wallIndex: 0, offsetMm: 2000 })
    const moved = plannerReducer(added, { type: 'set-opening', id: 'd1', patch: { offsetMm: 250 } })
    expect(moved.geometry.openings[0]?.offsetMm).toBe(250)
  })

  it('accepts nought, which is a door hard against the start of its wall', () => {
    const added = plannerReducer(start(), { type: 'add-opening', id: 'd1', kind: 'door', wallIndex: 0, offsetMm: 2000 })
    const moved = plannerReducer(added, { type: 'set-opening', id: 'd1', patch: { offsetMm: 0 } })
    expect(moved.geometry.openings[0]?.offsetMm).toBe(0)
  })

  it('puts a door typed past the end of its wall at the end of the wall, not off it', () => {
    const added = plannerReducer(start(), { type: 'add-opening', id: 'd1', kind: 'door', wallIndex: 0, offsetMm: 2000 })
    const moved = plannerReducer(added, { type: 'set-opening', id: 'd1', patch: { offsetMm: 9_000 } })
    // Wall zero is four metres long and the door is 900 wide.
    expect(moved.geometry.openings[0]?.offsetMm).toBe(3100)
  })

  it('moves a column by the shift a typed centre implies', () => {
    const added = plannerReducer(start(), {
      type: 'add-obstruction',
      id: 'c1',
      label: 'Column',
      x: 1000,
      y: 1000,
      widthMm: 400,
      depthMm: 400,
      heightMm: 2400,
    })
    const moved = plannerReducer(added, { type: 'move-obstruction', id: 'c1', dx: 500, dy: -250, settle: true })
    const box = boundingBox(moved.geometry.obstructions[0]?.vertices ?? [])
    expect(Math.round((box.minX + box.maxX) / 2)).toBe(1500)
    expect(Math.round((box.minY + box.maxY) / 2)).toBe(750)
  })
})
