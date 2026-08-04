'use client'

import { addToCart, getCart, subscribeCart } from '@/modules/shop/components/public/cart'
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

export type PlanCartLine = { productId: string; quantity: number }

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
  if (lines.length === 0) return { ok: false, error: 'There is nothing in this plan yet.' }

  const existing = readCart()
  const existingIds = new Set(existing.map((line) => line.productId))
  const newLines = lines.filter((line) => !existingIds.has(line.productId)).length

  if (existing.length + newLines > MEMBER_CART_MAX_LINES) {
    return {
      ok: false,
      error: `That would put more than ${MEMBER_CART_MAX_LINES} different things in your basket, which is as many as it holds. Take a few out and try again.`,
    }
  }

  for (const line of lines) {
    addToCart(line.productId, line.quantity)
  }
  return { ok: true, added: lines.length }
}

/**
 * What is in the basket right now, ready to be staged into the room.
 *
 * Quantity N becomes N individually placeable instances, parked in the staging
 * tray rather than scattered into the room - somebody arriving from the basket
 * has not drawn a room yet, and furniture appearing in a space that does not
 * exist is not a helpful first impression.
 */
export function cartAsStagedItems(): Array<{ productId: string; index: number }> {
  const out: Array<{ productId: string; index: number }> = []
  for (const line of readCart()) {
    const quantity = Math.max(1, Math.min(50, Math.round(line.quantity)))
    for (let index = 0; index < quantity; index++) out.push({ productId: line.productId, index })
  }
  return out
}
