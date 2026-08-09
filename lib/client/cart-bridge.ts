'use client'

import { addToCart, cartLineKey, getCart, subscribeCart } from '@/modules/shop/components/public/cart'
import type { CartLine } from '@/modules/shop/components/public/cart'

// Everything the planner does to the basket goes through shop's own cart
// utility. Never localStorage directly.
//
// This is not tidiness. A signed-in member's basket now syncs to the server and
// follows them between devices, and the utility arms that sync itself on the
// first read or write. A direct write to the storage key would work perfectly on
// the day and silently lose the cross-device behaviour - which surfaces a
// fortnight later as "the planner lost my basket", from a customer, about a bug
// with no error in it anywhere.

/** shop's server-side cap. Checked before writing rather than after a rejection. */
export const MEMBER_CART_MAX_LINES = 200

export function readCart(): CartLine[] {
  return getCart()
}

export function watchCart(callback: () => void): () => void {
  return subscribeCart(callback)
}

export type PlanCartLine = {
  productId: string
  quantity: number
  // Snapshots carried on the plan's items (see PlanItem.basketLine/basketBundle):
  // present, the LINE is replayed - identity, personalisation and grouping meta
  // intact, invisible companions multiplied out - so a desk saved with its
  // screens returns to the basket as the whole grouped set. Absent, the line is
  // the plain product id it always was.
  basketLine?: StagedBasketLine | null
  basketBundle?: StagedBundleLine[] | null
}

export type AddPlanResult = { ok: true; added: number } | { ok: false; error: string }

/**
 * Put a whole plan in the basket.
 *
 * N placed instances of one variant become one line of quantity N, which is both
 * how a buyer thinks about it and what keeps a large office plan comfortably
 * inside the line cap. The count is checked BEFORE writing, so a plan that would
 * not fit says so in a sentence instead of half-adding itself and then failing.
 *
 * Written in one pass rather than one call per instance: the sync layer debounces
 * its push, and a tight loop of writes would defeat that.
 */
export function addPlanToCart(lines: PlanCartLine[]): AddPlanResult {
  if (lines.length === 0) return { ok: false, error: 'There is nothing in this layout yet.' }

  // Everything about to be written, companions included, so the cap is checked
  // against the truth. Companion quantities scale with the main line's count.
  const writes: Array<{ productId: string; quantity: number; lineId?: string; meta?: Record<string, unknown> }> = []
  for (const line of lines) {
    writes.push({
      productId: line.productId,
      quantity: line.quantity,
      ...(line.basketLine?.lineId ? { lineId: line.basketLine.lineId } : {}),
      ...(line.basketLine?.meta ? { meta: line.basketLine.meta } : {}),
    })
    for (const companion of line.basketBundle ?? []) {
      writes.push({
        productId: companion.productId,
        quantity: companion.qtyPerMain * line.quantity,
        ...(companion.lineId ? { lineId: companion.lineId } : {}),
        ...(companion.meta ? { meta: companion.meta } : {}),
      })
    }
  }

  // What the basket already holds, so this TOPS UP rather than adds a second
  // copy of everything.
  //
  // shop's addToCart is `existing.quantity += quantity`, and a line staged from
  // the basket carries the basket's own lineId back with it - so the module's
  // headline journey (basket → "plan your space" → put all four in the room →
  // Add to basket) left a basket of eight desks, under a message saying four
  // had been added. Plain lines doubled too: with no lineId, addToCart matches
  // on product id and increments that instead.
  //
  // Written as a shortfall rather than as an assignment, deliberately. Placing
  // eight of something the basket has four of still takes it to eight, which is
  // the room being the thing the shopper means. Placing only two of the four
  // leaves all four alone: this button says "add to basket", and quietly
  // removing things somebody has already chosen is not a reading of that.
  const existing = readCart()
  const held = new Map(existing.map((line) => [cartLineKey(line), line.quantity]))
  const shortfalls = writes
    .map((write) => ({ ...write, quantity: write.quantity - (held.get(write.lineId ?? write.productId) ?? 0) }))
    .filter((write) => write.quantity > 0)

  const existingKeys = new Set(held.keys())
  const newLines = shortfalls.filter((w) => !existingKeys.has(w.lineId ?? w.productId)).length

  if (existing.length + newLines > MEMBER_CART_MAX_LINES) {
    return {
      ok: false,
      error: `That would put more than ${MEMBER_CART_MAX_LINES} different things in your basket, which is as many as it holds. Take a few out and try again.`,
    }
  }

  for (const write of shortfalls) {
    addToCart(write.productId, write.quantity, write.lineId || write.meta ? { lineId: write.lineId, meta: write.meta } : undefined)
  }
  // `added` counts what genuinely changed, because the message it feeds is read
  // as a statement about the basket. Zero is the ordinary answer for a plan the
  // shopper arrived at from the basket and did not change.
  return { ok: true, added: shortfalls.length }
}

// The `modelContext` a line's meta may carry - the 3D module's documented
// shape, written at add-to-basket by whichever module grouped the lines (a
// product-accessories box). Read structurally, no import: the writing module
// may not be installed, and a malformed bag simply reads as no context.
//
//   On a MAIN line:  { contexts: string[], extraValueIds: string[] } - the
//     add-on combination its combined model should be drawn with. With
//     `contextsFrom: 'bundle'` alongside them, that list is a SUMMARY of the
//     group's own add-on lines and is re-derived from them here instead of
//     being trusted: a shopper who takes the screens back out on the basket page
//     is nowhere near the component that wrote it, so the stored list would go
//     on claiming screens the basket no longer holds.
//   On an ADD-ON line: { stage: 'none' | 'self' } - 'none' means the item is
//     already inside its main line's combined model (or is a fit-inside part
//     like a shelf) and must not stage as loose furniture of its own. It may
//     also carry { contextKey, valueIds } - its own contribution to the group's
//     combined model, which is what the re-derivation above reads.
export type StagedModelContext = { context: string; extraValueIds: string[] }
export type StagedBasketLine = { lineId: string | null; meta: Record<string, unknown> | null }
export type StagedBundleLine = StagedBasketLine & { productId: string; qtyPerMain: number }

type ReadLine = {
  staged: StagedModelContext | null
  stageSelf: boolean
  bundleKey: string | null
  bundleOf: string | null
  qtyPerMain: number
  /** Set when the main line's contexts are a re-derivable summary of its group. */
  derivable: boolean
  /** An add-on line's own contribution to its group's combined model. */
  contextKey: string | null
  valueIds: string[]
}

/** The same sorted-join signature p3d matches model tags against. */
function toStaged(contexts: string[], extraValueIds: string[]): StagedModelContext | null {
  const keys = contexts.filter(Boolean)
  if (keys.length === 0) return null
  return { context: [...keys].sort().join('+'), extraValueIds: extraValueIds.slice(0, 40) }
}

function readLineModelContext(meta: Record<string, unknown> | undefined): ReadLine {
  const none: ReadLine = {
    staged: null,
    stageSelf: true,
    bundleKey: null,
    bundleOf: null,
    qtyPerMain: 1,
    derivable: false,
    contextKey: null,
    valueIds: [],
  }
  const raw = meta?.modelContext
  if (!raw || typeof raw !== 'object') return none
  const bag = raw as {
    contexts?: unknown
    extraValueIds?: unknown
    stage?: unknown
    bundleKey?: unknown
    bundleOf?: unknown
    qtyPerMain?: unknown
    contextsFrom?: unknown
    contextKey?: unknown
    valueIds?: unknown
  }
  const bundleKey = typeof bag.bundleKey === 'string' && bag.bundleKey ? bag.bundleKey : null
  const bundleOf = typeof bag.bundleOf === 'string' && bag.bundleOf ? bag.bundleOf : null
  const qtyPerMain = typeof bag.qtyPerMain === 'number' && bag.qtyPerMain >= 1 ? Math.round(bag.qtyPerMain) : 1
  const derivable = bag.contextsFrom === 'bundle'
  const contextKey = typeof bag.contextKey === 'string' && bag.contextKey ? bag.contextKey : null
  const valueIds = Array.isArray(bag.valueIds) ? bag.valueIds.filter((v): v is string => typeof v === 'string') : []
  const rest = { bundleKey, bundleOf, qtyPerMain, derivable, contextKey, valueIds }
  if (bag.stage === 'none') return { ...none, ...rest, stageSelf: false }
  const contexts = Array.isArray(bag.contexts) ? bag.contexts.filter((c): c is string => typeof c === 'string' && !!c) : []
  const extraValueIds = Array.isArray(bag.extraValueIds) ? bag.extraValueIds.filter((v): v is string => typeof v === 'string') : []
  return { ...none, ...rest, staged: toStaged(contexts, extraValueIds) }
}

/**
 * What is in the basket right now, ready to be staged into the room.
 *
 * Quantity N becomes N individually placeable instances, parked in the staging
 * tray rather than scattered into the room - somebody arriving from the basket
 * has not drawn a room yet, and furniture appearing in a space that does not
 * exist is not a helpful first impression.
 *
 * Grouped lines: a main line bought with add-ons stages with its combined-model
 * context (the desk arrives WITH its screens, as one thing), and an add-on line
 * whose meta says it is already inside that model stages nothing at all -
 * otherwise the same screens would also lean against the wall as loose panels.
 * Add-on lines marked placeable ('self' - a pedestal at an odd quantity) stage
 * exactly like anything else.
 */
export type StagedEntry = {
  productId: string
  index: number
  modelContext: StagedModelContext | null
  // The line this instance came from, and - for a line that bundles invisible
  // companions (screens riding inside the combined desk model) - the
  // companions themselves per one unit, so add-plan-to-basket can put the
  // whole set back rather than a bare product id.
  basketLine: StagedBasketLine
  basketBundle: StagedBundleLine[] | null
}

export function cartAsStagedItems(): StagedEntry[] {
  const out: StagedEntry[] = []
  const lines = readCart()
  for (const line of lines) {
    const { staged, stageSelf, bundleKey, derivable } = readLineModelContext(line.meta)
    if (!stageSelf) continue

    // The invisible companions of a bundling line: every line pointing back at
    // this one's bundle key that does NOT stage as its own item. (A companion
    // that stages on its own carries its own snapshot on its own instances.)
    let bundle: StagedBundleLine[] | null = null
    let derived: StagedModelContext | null = null
    if (bundleKey) {
      const group = lines.map((other) => ({ other, read: readLineModelContext(other.meta) })).filter((entry) => entry.read.bundleOf === bundleKey)
      const companions = group
        .filter((entry) => !entry.read.stageSelf)
        .map((entry) => ({
          productId: entry.other.productId,
          lineId: entry.other.lineId ?? null,
          meta: entry.other.meta ?? null,
          qtyPerMain: entry.read.qtyPerMain,
        }))
      if (companions.length > 0) bundle = companions

      // Re-derived from the group as it stands, so an add-on removed on the
      // basket page stops being drawn on the desk. Only for a main line that
      // says its list is a summary - anything older keeps the stored list, which
      // is the only answer it has.
      if (derivable) {
        derived = toStaged(
          group.map((entry) => entry.read.contextKey).filter((key): key is string => !!key),
          group.flatMap((entry) => entry.read.valueIds),
        )
      }
    }

    const quantity = Math.max(1, Math.min(50, Math.round(line.quantity)))
    for (let index = 0; index < quantity; index++) {
      out.push({
        productId: line.productId,
        index,
        modelContext: derivable ? derived : staged,
        basketLine: { lineId: line.lineId ?? null, meta: line.meta ?? null },
        basketBundle: bundle,
      })
    }
  }
  return out
}
