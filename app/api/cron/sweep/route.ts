import { NextRequest, NextResponse } from 'next/server'
import { getSplConfig } from '@/modules/space-planner-for-shop/lib/config'
import { listStaleProductIds } from '@/modules/space-planner-for-shop/lib/db/dimension-cache'
import { resolveDimensions } from '@/modules/space-planner-for-shop/lib/resolve-dimensions'
import { purgeOldEvents } from '@/modules/space-planner-for-shop/lib/db/events'
import { deleteOrphanedRooms } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { failStaleRenderJobs } from '@/modules/space-planner-for-shop/lib/db/jobs'

// The nightly tidy-up. Four small jobs, all bounded, declared as a cron in the
// manifest so no core file needs editing.
//
// Bounded is the point. Everything here shares the dispatcher's sixty-second
// ceiling, so the dimension sweep takes a slice off the stale tail rather than
// trying to rebuild the catalogue - the owner has a resumable rebuild in the
// admin for that, with a progress bar and a stop button.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const config = await getSplConfig()
  const report: Record<string, number> = {}

  // 1. Refresh a bounded slice of the stale dimension tail.
  const stale = await listStaleProductIds(config.nightlyDimensionSweep)
  if (stale.length > 0) {
    const resolved = await resolveDimensions(stale, { force: true })
    report.dimensionsRefreshed = resolved.size
  } else {
    report.dimensionsRefreshed = 0
  }

  // 2. Purge the anonymous event counters past their retention.
  report.eventsPurged = await purgeOldEvents(config.eventRetentionDays)

  // 3. Rooms whose member no longer exists. Core owns the Member table and this
  //    module cannot foreign-key to it, so deletion does not cascade here on its
  //    own - and personal data left behind after a deletion request is a
  //    compliance failure rather than a bug.
  report.orphanedRoomsRemoved = await deleteOrphanedRooms()

  // 4. Renders that were picked up and never came back. Without this, one worker
  //    crash locks that plan out of ever being rendered again, because there is
  //    only ever one live job per plan.
  report.staleRendersFailed = await failStaleRenderJobs()

  return NextResponse.json({ ok: true, ...report })
}
