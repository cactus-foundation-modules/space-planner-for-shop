import { NextRequest, NextResponse } from 'next/server'
import { verifyInternalExportBearer } from '@/lib/members/export'
import { listRoomsForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { listPlansForMember, listPlanVersions } from '@/modules/space-planner-for-shop/lib/db/plans'
import { listRendersForPlan } from '@/modules/space-planner-for-shop/lib/db/jobs'
import { listViewsForRoom } from '@/modules/space-planner-for-shop/lib/db/room-views'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'

// This module's contribution to a member's GDPR export.
//
// Internal bearer only - called self-origin by core's assembleMemberExport, and
// never reachable with a browser session.
//
// It exports the plans themselves, not a summary of them. A room somebody
// measured and four layouts they tried in it is exactly the sort of thing an
// Article 20 request is for, and "we hold some space planner data" would be a
// poor answer.
export async function GET(request: NextRequest) {
  if (!verifyInternalExportBearer(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const memberId = request.headers.get('x-cactus-member-id')
  if (!memberId) return NextResponse.json({ error: 'Missing member id' }, { status: 400 })

  // Sized from what this shop actually lets a member keep, rather than from a
  // round number. At the stock settings the old cap of 500 sat below the 625 a
  // member is allowed, so somebody near their limit was handed an export that
  // claimed to be everything and was not - which is the one thing an Article 20
  // answer may not be.
  const config = await getSplConfigCached()
  const planCap = Math.max(500, config.maxRoomsPerMember * config.maxPlansPerRoom)

  const [rooms, plans] = await Promise.all([listRoomsForMember(memberId), listPlansForMember(memberId, planCap)])

  // Viewpoints hang off the room rather than the plan, so they are gathered per
  // room rather than folded into planDetail below. They are small, they are the
  // member's own choices about how they want their space looked at, and leaving
  // them out would make this export quietly incomplete.
  const roomDetail = await Promise.all(
    rooms.map(async (entry) => ({
      ...entry.room,
      views: await listViewsForRoom(entry.room.id),
    })),
  )

  const planDetail = await Promise.all(
    plans.map(async (plan) => ({
      plan,
      versions: await listPlanVersions(plan.id),
      // Every picture, not the twenty most recent the default returns: a
      // photograph the member asked for is theirs, and an export that keeps
      // some of them back is not an export.
      renders: (await listRendersForPlan(plan.id, 1000)).map((job) => ({
        status: job.status,
        url: job.resultUrl,
        createdAt: job.createdAt,
      })),
    })),
  )

  return NextResponse.json({
    rooms: roomDetail,
    plans: planDetail,
  })
}
