'use client'

import type { PlanItem, RoomGeometry } from '@/modules/space-planner-for-shop/lib/types'

// The signed-out visitor's work.
//
// Nothing a guest does is persisted on the server - that is the deliberate trade
// in §3 of the plan, and it deletes an entire class of problem (anonymous rows,
// guest retention sweeps, adoption reconciliation, unauthenticated writes to rate
// limit). What it costs is a visitor who closes the tab, and this is what pays
// that back: the scratch room and layout live in localStorage exactly as the cart
// does, so coming back to the site restores what they were doing.

const KEY = 'cactus_space_planner_scratch'
const VERSION = 1

export type Scratch = {
  version: number
  geometry: RoomGeometry
  items: PlanItem[]
  savedAt: number
}

export function readScratch(): Scratch | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Scratch
    if (parsed?.version !== VERSION || !parsed.geometry || !Array.isArray(parsed.items)) return null
    return parsed
  } catch {
    // Private browsing, a full quota, a half-written blob. None of those is worth
    // an error message on a page somebody came to draw a room on.
    return null
  }
}

export function writeScratch(geometry: RoomGeometry, items: PlanItem[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ version: VERSION, geometry, items, savedAt: Date.now() } satisfies Scratch))
  } catch {
    // Quota exceeded is cache-off, never an error the shopper sees.
  }
}

export function clearScratch(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // As above.
  }
}
