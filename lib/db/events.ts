import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

// Counters, not tracking.
//
// No IP address, no session id, no member id, nothing that identifies a person -
// the same shape and the same retention discipline as the search module's query
// log. What it buys is the ability to answer the two questions the owner
// actually asks: is anybody using this, and what should we get 3D-modelled next.
//
// Writing is fire-and-forget and never blocks or breaks the thing it is counting.
// A planner that will not let somebody place a desk because the analytics insert
// failed has its priorities backwards.

export type SplEventName =
  | 'planner.opened'
  | 'planner.opened-from-cart'
  | 'planner.opened-from-product'
  | 'room.saved'
  | 'plan.saved'
  | 'item.placed'
  | 'plan.quoted'
  | 'plan.emailed'
  | 'plan.shared'
  | 'plan.rendered'
  | 'plan.exported'
  | 'plan.printed'

export async function recordEvent(
  event: SplEventName,
  opts: { planId?: string | null; productId?: string | null; memberId?: string | null } = {},
): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "spl_events" ("event", "plan_id", "product_id", "member_id")
      VALUES (${event}, ${opts.planId ?? null}, ${opts.productId ?? null}, ${opts.memberId ?? null})
    `
  } catch {
    // Deliberately swallowed. See the note at the top of the file.
  }
}

export async function recordEvents(events: Array<{ event: SplEventName; planId?: string | null; productId?: string | null }>): Promise<void> {
  if (events.length === 0) return
  try {
    for (const entry of events) {
      await prisma.$executeRaw`
        INSERT INTO "spl_events" ("event", "plan_id", "product_id")
        VALUES (${entry.event}, ${entry.planId ?? null}, ${entry.productId ?? null})
      `
    }
  } catch {
    // As above.
  }
}

// No basket handoff count here, deliberately. Sending a layout to the basket
// happens entirely in the browser (lib/client/cart-bridge.ts), so there is no
// server call to count and the number could only ever have been zero. A stat
// that is always nought reads as "nobody does this" rather than "we do not
// measure this", which is worse than not showing it.
export type EventSummary = {
  plansThisWeek: number
  roomsThisWeek: number
  quotesThisWeek: number
  openedThisWeek: number
}

export async function getEventSummary(): Promise<EventSummary> {
  const rows = await prisma.$queryRaw<{ event: string; count: bigint }[]>`
    SELECT "event", COUNT(*)::bigint AS count
    FROM "spl_events"
    WHERE "created_at" > CURRENT_TIMESTAMP - INTERVAL '7 days'
    GROUP BY "event"
  `
  const map = new Map(rows.map((row) => [row.event, Number(row.count)]))
  return {
    plansThisWeek: map.get('plan.saved') ?? 0,
    roomsThisWeek: map.get('room.saved') ?? 0,
    quotesThisWeek: map.get('plan.quoted') ?? 0,
    openedThisWeek: (map.get('planner.opened') ?? 0) + (map.get('planner.opened-from-cart') ?? 0) + (map.get('planner.opened-from-product') ?? 0),
  }
}

/**
 * What shoppers keep putting in rooms that we have no model for.
 *
 * This is the single most useful number the module produces for the owner: it
 * turns "which products should we get 3D-modelled" from a hunch into a list, in
 * demand order.
 */
export async function listMostPlacedWithoutModel(limit = 20): Promise<Array<{ productId: string; name: string; placements: number }>> {
  const rows = await prisma.$queryRaw<Array<{ product_id: string; name: string; count: bigint }>>`
    SELECT e."product_id", p."name", COUNT(*)::bigint AS count
    FROM "spl_events" e
    JOIN "shp_products" p ON p."id" = e."product_id"
    WHERE e."event" = 'item.placed'
      AND NOT EXISTS (SELECT 1 FROM "p3d_models" m WHERE m."product_id" = e."product_id")
    GROUP BY e."product_id", p."name"
    ORDER BY count DESC
    LIMIT ${limit}
  `
  return rows.map((row) => ({ productId: row.product_id, name: row.name, placements: Number(row.count) }))
}

export async function purgeOldEvents(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  return prisma.$executeRaw`DELETE FROM "spl_events" WHERE "created_at" < ${cutoff}`
}

/**
 * How many of these expensive actions this member has taken lately.
 *
 * Counting our own rows rather than reaching for core's limiter is deliberate:
 * core's RateLimitAction is a closed union with no module extension point, so
 * adding one entry to it would force a core release for what is module-local
 * work. Contact-form counts its own rows for the same reason.
 */
/**
 * How many of these this MEMBER has run inside the window.
 *
 * Counted off the member rather than off their current plan ids, which is what
 * countRecentEvents below does and why it is no longer what the rate limits
 * call: an orphaned event counts for nothing, so deleting the plans handed the
 * allowance straight back. Migration 004 fixed the render limit the same way,
 * by counting a table that knows whose job it was.
 */
export async function countRecentEventsForMember(event: SplEventName, memberId: string, windowMinutes: number): Promise<number> {
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000)
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "spl_events"
    WHERE "event" = ${event} AND "created_at" > ${cutoff} AND "member_id" = ${memberId}
  `
  return Number(rows[0]?.count ?? 0)
}

export async function countRecentEvents(event: SplEventName, planIds: string[], windowMinutes: number): Promise<number> {
  if (planIds.length === 0) return 0
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000)
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "spl_events"
    WHERE "event" = ${event} AND "created_at" > ${cutoff}
      AND "plan_id" IN (${Prisma.join(planIds)})
  `
  return Number(rows[0]?.count ?? 0)
}
