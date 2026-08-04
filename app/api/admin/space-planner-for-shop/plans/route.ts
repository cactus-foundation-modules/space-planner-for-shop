import { NextRequest, NextResponse } from 'next/server'
import { requireSplUser } from '@/modules/space-planner-for-shop/lib/access'
import { listPlansForAdmin } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getEventSummary, listMostPlacedWithoutModel } from '@/modules/space-planner-for-shop/lib/db/events'

// The Rooms & plans screen.
//
// Useful in its own right the moment a customer rings up about a layout they
// saved - which is the actual reason this screen exists rather than the
// analytics, though the analytics are what justify the 3D modelling budget.
export async function GET(request: NextRequest) {
  const gate = await requireSplUser('space-planner.access', { allowAccess: true })
  if (gate.error) return gate.error

  const params = request.nextUrl.searchParams
  const { rows, total } = await listPlansForAdmin({
    page: Number(params.get('page') ?? '1'),
    perPage: Number(params.get('perPage') ?? '25'),
    search: params.get('search') ?? undefined,
  })

  const [summary, wanted] = await Promise.all([
    getEventSummary(),
    params.get('withInsights') === '1' ? listMostPlacedWithoutModel() : Promise.resolve([]),
  ])

  return NextResponse.json({
    rows: rows.map((row) => ({
      id: row.plan.id,
      name: row.plan.name,
      roomName: row.roomName,
      member: row.memberUsername ?? row.memberEmail ?? 'Deleted account',
      itemCount: row.plan.items.items.filter((item) => !item.staged).length,
      quoted: Boolean(row.plan.quoteId),
      shared: Boolean(row.plan.shareToken),
      updatedAt: row.plan.updatedAt,
    })),
    total,
    summary,
    wanted,
  })
}
