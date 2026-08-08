import { NextRequest, NextResponse } from 'next/server'
import { getSplConfig } from '@/modules/space-planner-for-shop/lib/config'
import { deleteOrphanedDimensions, listStaleProductIds } from '@/modules/space-planner-for-shop/lib/db/dimension-cache'
import { resolveDimensions } from '@/modules/space-planner-for-shop/lib/resolve-dimensions'
import { purgeOldEvents } from '@/modules/space-planner-for-shop/lib/db/events'
import { deleteOrphanedRooms } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { claimedMachineIds, failStaleRenderJobs } from '@/modules/space-planner-for-shop/lib/db/jobs'
import { sweepOrphanMachines } from '@/modules/space-planner-for-shop/lib/fly/render-worker'

// The nightly tidy-up. Six small jobs, all bounded, declared as a cron in the
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

  // 2. Cached sizes for products the shop has since deleted. Same reason as the
  //    rooms below: the shop owns shp_products and this module does not
  //    foreign-key into it, so nothing cascades. Unbounded on purpose - one hash
  //    anti-join over two tables the size of the catalogue, which is nothing
  //    against this job's budget, and a bounded slice would only postpone the
  //    miscount it exists to prevent.
  report.orphanedDimensionsRemoved = await deleteOrphanedDimensions()

  // 3. Purge the anonymous event counters past their retention.
  report.eventsPurged = await purgeOldEvents(config.eventRetentionDays)

  // 4. Rooms whose member no longer exists. Core owns the Member table and this
  //    module cannot foreign-key to it, so deletion does not cascade here on its
  //    own - and personal data left behind after a deletion request is a
  //    compliance failure rather than a bug.
  report.orphanedRoomsRemoved = await deleteOrphanedRooms()

  // 5. Renders that were picked up and never came back. Without this, one worker
  //    crash locks that plan out of ever being rendered again, because there is
  //    only ever one live job per plan.
  report.staleRendersFailed = await failStaleRenderJobs()

  // 6. Picture machines nothing is waiting on any more. The third and last
  //    layer of the shutdown story: the callback destroys a machine the moment
  //    its picture lands, the machine destroys itself if it goes quiet, and this
  //    catches the one that managed neither. Runs AFTER step 5, so a job just
  //    aged out no longer claims its machine and the machine goes with it.
  report.orphanMachinesDestroyed = await sweepOrphanMachines(await claimedMachineIds()).catch(() => 0)

  return NextResponse.json({ ok: true, ...report })
}
