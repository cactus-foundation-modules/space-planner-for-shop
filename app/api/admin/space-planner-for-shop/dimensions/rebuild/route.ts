import { NextRequest, NextResponse } from 'next/server'
import { requireSplUser } from '@/modules/space-planner-for-shop/lib/access'
import { cancelBackfill, createBackfill, getActiveBackfill, getBackfill } from '@/modules/space-planner-for-shop/lib/db/jobs'
import { countActiveProducts } from '@/modules/space-planner-for-shop/lib/db/dimension-cache'
import { runBackfillStep } from '@/modules/space-planner-for-shop/lib/backfill-run'

// The resumable rebuild.
//
// POST with no job id starts one; POST with a job id runs the next bounded step.
// The admin screen loops the second call and draws a progress bar off the row.
// That is the whole design: twenty-two thousand products does not fit in a
// sixty-second route, and a button that appears to hang is worse than no button.

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error

  const body = (await request.json().catch(() => ({}))) as { jobId?: string }

  if (!body.jobId) {
    const existing = await getActiveBackfill()
    if (existing) return NextResponse.json({ job: existing, message: 'A rebuild is already running.' })

    const total = await countActiveProducts()
    const job = await createBackfill(total)
    return NextResponse.json({ job, message: `Rebuilding sizes for ${total} products.` })
  }

  const result = await runBackfillStep(body.jobId)
  return NextResponse.json({ job: result.job, done: result.done, message: result.message })
}

export async function DELETE(request: NextRequest) {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error

  const jobId = request.nextUrl.searchParams.get('jobId')
  if (!jobId) return NextResponse.json({ error: 'Which rebuild?' }, { status: 400 })

  await cancelBackfill(jobId)
  return NextResponse.json({ job: await getBackfill(jobId) })
}
