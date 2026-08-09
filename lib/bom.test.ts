import { describe, expect, it } from 'vitest'
import { planToCartLines } from '@/modules/space-planner-for-shop/lib/bom'
import { countPlanProducts, planProductIds } from '@/modules/space-planner-for-shop/lib/plan-counts'
import { PLAN_SCHEMA_VERSION } from '@/modules/space-planner-for-shop/lib/types'
import type { PlanItem, PlanItems } from '@/modules/space-planner-for-shop/lib/types'

// A desk bought with its screens carries those screens as a bundle on the item
// rather than as items of their own: they are drawn inside the combined model
// and they go back to the basket with the desk. Counting the items alone left
// them out of every priced thing the planner produces - the item list, the PDF,
// the emailed plan and the quote - so a quote for twelve desks-with-screens went
// out priced as twelve bare desks.
//
// buildBom needs the shop's own pricing and tax settings, so the arithmetic is
// pinned here on planToCartLines, which carries the identical counting rule.

function item(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'i1',
    productId: 'desk',
    x: 0,
    y: 0,
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
    modelContext: null,
    basketLine: null,
    basketBundle: null,
    ...overrides,
  }
}

const plan = (items: PlanItem[]): PlanItems => ({ version: PLAN_SCHEMA_VERSION, items })

const screens = [{ productId: 'screen', lineId: null, meta: null, qtyPerMain: 2 }]

describe('turning a plan into cart lines', () => {
  it('counts the companions bought with an item', () => {
    const lines = planToCartLines(plan([item({ id: 'i1', basketBundle: screens })]))
    expect(lines).toEqual(
      expect.arrayContaining([
        { productId: 'desk', quantity: 1 },
        { productId: 'screen', quantity: 2 },
      ]),
    )
  })

  it('multiplies the companions out across every instance', () => {
    const lines = planToCartLines(
      plan([
        item({ id: 'i1', basketBundle: screens }),
        item({ id: 'i2', basketBundle: screens }),
        item({ id: 'i3', basketBundle: screens }),
      ]),
    )
    expect(lines).toEqual(
      expect.arrayContaining([
        { productId: 'desk', quantity: 3 },
        { productId: 'screen', quantity: 6 },
      ]),
    )
  })

  it('leaves anything still waiting in the tray out of it, companions included', () => {
    const lines = planToCartLines(
      plan([item({ id: 'i1', basketBundle: screens }), item({ id: 'i2', staged: true, basketBundle: screens })]),
    )
    expect(lines).toEqual(
      expect.arrayContaining([
        { productId: 'desk', quantity: 1 },
        { productId: 'screen', quantity: 2 },
      ]),
    )
  })

  it('adds a companion to its own placed instances rather than replacing them', () => {
    // A pedestal can ride inside one desk's model AND stand on the floor beside
    // another as an item in its own right. Both have to count.
    const lines = planToCartLines(
      plan([
        item({ id: 'i1', basketBundle: [{ productId: 'pedestal', lineId: null, meta: null, qtyPerMain: 1 }] }),
        item({ id: 'i2', productId: 'pedestal' }),
      ]),
    )
    expect(lines).toEqual(
      expect.arrayContaining([
        { productId: 'desk', quantity: 1 },
        { productId: 'pedestal', quantity: 2 },
      ]),
    )
  })

  it('is unchanged for a plan with no bundles in it', () => {
    const lines = planToCartLines(plan([item({ id: 'i1' }), item({ id: 'i2' }), item({ id: 'i3', productId: 'chair' })]))
    expect(lines).toEqual(
      expect.arrayContaining([
        { productId: 'desk', quantity: 2 },
        { productId: 'chair', quantity: 1 },
      ]),
    )
    expect(lines).toHaveLength(2)
  })
})

describe('one counting rule, everywhere', () => {
  // The browser prints a running total and an item list; the server prices the
  // same plan into a PDF, an email and a quote. They disagreed once - the
  // paperwork counted bundled add-ons and the screen did not - so a quote could
  // go out for more than the planner had ever shown. Both sides now call
  // countPlanProducts, and this is the guard against them drifting apart again.
  const items = [
    item({ id: 'i1', basketBundle: screens }),
    item({ id: 'i2', basketBundle: screens }),
    item({ id: 'i3', productId: 'chair' }),
    item({ id: 'i4', staged: true, basketBundle: screens }),
  ]

  it('gives the cart lines and the counts the same answer', () => {
    const fromCounts = [...countPlanProducts(items).entries()].map(([productId, quantity]) => ({ productId, quantity }))
    expect(planToCartLines(plan(items)).sort((a, b) => a.productId.localeCompare(b.productId))).toEqual(
      fromCounts.sort((a, b) => a.productId.localeCompare(b.productId)),
    )
  })

  it('asks for every product it is going to price, companions included', () => {
    // Counting a companion the browser never fetched would price it at nothing.
    const ids = planProductIds(items)
    for (const productId of countPlanProducts(items).keys()) expect(ids).toContain(productId)
  })

  it('asks for a waiting item too, so the tray can show it', () => {
    expect(planProductIds(items)).toContain('screen')
    expect(planProductIds([item({ id: 'i1', staged: true, productId: 'only-waiting' })])).toContain('only-waiting')
  })
})
