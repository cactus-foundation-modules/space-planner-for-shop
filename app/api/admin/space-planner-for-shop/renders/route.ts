import { NextResponse } from 'next/server'
import { requireSplUser } from '@/modules/space-planner-for-shop/lib/access'
import { listRenderJobsForAdmin } from '@/modules/space-planner-for-shop/lib/db/jobs'
import { renderWorkerConfigured } from '@/modules/space-planner-for-shop/lib/config'

// The render log, with its errors visible. A picture service that fails silently
// is one the owner finds out about from a customer.
export async function GET() {
  const gate = await requireSplUser('space-planner.access', { allowAccess: true })
  if (gate.error) return gate.error

  return NextResponse.json({
    jobs: await listRenderJobsForAdmin(),
    workerConfigured: renderWorkerConfigured(),
  })
}
