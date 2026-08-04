import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { getPlanForMember, listPlansForMember } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { createRenderJob, getLiveRenderForPlan, listRendersForPlan, markRenderRunning } from '@/modules/space-planner-for-shop/lib/db/jobs'
import { getSplConfigCached, renderWorkerConfigured } from '@/modules/space-planner-for-shop/lib/config'
import { countRecentEvents, recordEvent } from '@/modules/space-planner-for-shop/lib/db/events'
import { buildScene } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import { resolveModelsForProducts } from '@/modules/space-planner-for-shop/lib/model-resolver'

// Enqueue a photoreal render, and poll for it.
//
// Enqueue and poll only: a module route has sixty seconds and background work
// started with after() is starved along with it, so nothing render-shaped ever
// runs inline. The worker gets the same scene description the browser draws from
// - one scene-assembly library, two consumers - because a render assembled a
// second way is how renders quietly stop matching plans.

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const jobs = await listRendersForPlan(id)
  return NextResponse.json({
    jobs: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      url: job.resultUrl,
      error: job.error,
      createdAt: job.createdAt,
      // A render is a photograph of a moment. If the plan has moved on since,
      // the picture is labelled with the date it depicts rather than presented
      // as current.
      stale: Boolean(job.planUpdatedAt && job.planUpdatedAt.getTime() !== plan.updatedAt.getTime()),
      depicts: job.planUpdatedAt,
    })),
    available: renderWorkerConfigured(),
  })
}

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const config = await getSplConfigCached()
  if (!config.rendersEnabled) {
    return NextResponse.json({ error: 'Pictures are switched off at the moment.' }, { status: 403 })
  }
  if (!renderWorkerConfigured()) {
    return NextResponse.json({ error: 'The picture service is not set up on this site yet.' }, { status: 503 })
  }

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const room = await getRoomForMember(plan.roomId, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // One live job per plan. Asking twice returns the job already running rather
  // than starting a second one and paying for both.
  const live = await getLiveRenderForPlan(id)
  if (live) return NextResponse.json({ job: { id: live.id, status: live.status } })

  const mine = await listPlansForMember(gate.member.id)
  const recent = await countRecentEvents('plan.rendered', mine.map((p) => p.id), config.rateLimitWindowMin)
  if (recent >= config.maxRendersPerWindow) {
    return NextResponse.json({ error: 'You have asked for a few pictures just now. Give those a moment and try again.' }, { status: 429 })
  }

  const productIds = [...new Set(plan.items.items.filter((item) => !item.staged).map((item) => item.productId))]
  const models = await resolveModelsForProducts(productIds)
  const scene = buildScene(room.geometry, plan.items, plan.productSnapshot, new Map([...models].map(([key, value]) => [key, value])))

  const job = await createRenderJob({
    planId: id,
    memberId: gate.member.id,
    params: { view: 'eye-level' },
    planUpdatedAt: plan.updatedAt,
  })

  // Fire the worker and do not wait for the picture. It calls back.
  const dispatched = await dispatchToWorker(job.id, scene, models)
  if (!dispatched) {
    return NextResponse.json({ error: 'The picture service did not answer. Please try again shortly.' }, { status: 502 })
  }
  await markRenderRunning(job.id)
  await recordEvent('plan.rendered', { planId: id })

  return NextResponse.json({ job: { id: job.id, status: 'RUNNING' } })
}

async function dispatchToWorker(
  jobId: string,
  scene: ReturnType<typeof buildScene>,
  models: Awaited<ReturnType<typeof resolveModelsForProducts>>,
): Promise<boolean> {
  const url = process.env.SPACE_PLANNER_RENDER_URL
  const secret = process.env.SPACE_PLANNER_RENDER_SECRET
  if (!url || !secret) return false

  const { getRenderCallbackToken } = await import('@/modules/space-planner-for-shop/lib/db/jobs')
  const callbackToken = await getRenderCallbackToken(jobId)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        jobId,
        scene,
        // Signed urls, minted now and good for a couple of days - long enough for
        // any render, short enough that a leaked job payload is not a model
        // library.
        models: [...models.values()].map((model) => ({
          productId: model.productId,
          url: model.fetchUrl,
          format: model.format,
          yawOffsetDeg: model.yawOffsetDeg,
        })),
        callbackUrl: `${getSiteUrl()}/api/m/space-planner-for-shop/public/render-callback`,
        callbackToken,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    return response.ok
  } catch {
    return false
  }
}
