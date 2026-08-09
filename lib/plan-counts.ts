import type { PlanItem } from '@/modules/space-planner-for-shop/lib/types'

// How many of each product a plan actually contains.
//
// One rule, in one place, because it is asked on both sides of the wire and the
// two answers have to match: the browser prints a running total and an item
// list, and the server prices the same plan into a PDF, an email and a quote.
// When they disagreed - the browser counting placed items, the server counting
// those plus their bundled companions - the same plan showed £4,200 on screen
// and £5,600 on the paperwork.
//
// Deliberately free of imports beyond the type, so the server file and the
// client component can both have it.

/**
 * Every product in the plan, with how many of it there are.
 *
 * Placed items count once each. So do the companions bought with them - the
 * screens riding inside a combined desk model, a shelf that fits inside the
 * unit - which are drawn in the room and go back to the basket with their item
 * but are not items of their own. `qtyPerMain` is stored per one unit, so an
 * item carrying two screens contributes two per instance.
 *
 * Anything still waiting in the tray is left out: it is not in the room yet.
 */
export function countPlanProducts(items: PlanItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (item.staged) continue
    counts.set(item.productId, (counts.get(item.productId) ?? 0) + 1)
    for (const companion of item.basketBundle ?? []) {
      counts.set(companion.productId, (counts.get(companion.productId) ?? 0) + companion.qtyPerMain)
    }
  }
  return counts
}

/** Every product id a plan references, companions included. What to fetch. */
export function planProductIds(items: PlanItem[]): string[] {
  const ids = new Set<string>()
  for (const item of items) {
    ids.add(item.productId)
    for (const companion of item.basketBundle ?? []) ids.add(companion.productId)
  }
  return [...ids]
}
