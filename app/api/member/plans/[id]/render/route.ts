import { NextRequest, NextResponse } from 'next/server'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { getPlanForMember, listPlansForMember } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import {
  createRenderJob,
  finishRenderJob,
  getLiveRenderForPlan,
  getRenderCallbackToken,
  listRendersForPlan,
  markRenderRunning,
  setRenderMachine,
} from '@/modules/space-planner-for-shop/lib/db/jobs'
import { getSplConfigCached, renderEnvConfigured, renderWorkerConfigured } from '@/modules/space-planner-for-shop/lib/config'
import { countRecentEvents, recordEvent } from '@/modules/space-planner-for-shop/lib/db/events'
import { buildRenderJobPayload, RenderStorageError, type RenderJobPayload } from '@/modules/space-planner-for-shop/lib/render-dispatch'
import { createRenderMachine, destroyRenderMachine } from '@/modules/space-planner-for-shop/lib/fly/render-worker'
import { SplFlyError } from '@/modules/space-planner-for-shop/lib/fly/api'

// Enqueue a photoreal render, and poll for it.
//
// Enqueue and poll only: a module route has sixty seconds and background work
// started with after() is starved along with it, so nothing render-shaped ever
// runs inline. What happens here is a machine being asked for and a job being
// posted to it - both of which are quick, and neither of which involves drawing
// anything.
//
// Two ways to be wired up, one payload. Ordinarily the site made its own Fly
// app and every picture gets a machine of its own that destroys itself
// afterwards. If SPACE_PLANNER_RENDER_URL is set instead, somebody runs their
// own worker and we simply post to it - no machine is created, and none is
// destroyed, because it is not ours.

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
    available: await renderWorkerConfigured(),
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
  if (!(await renderWorkerConfigured())) {
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

  const job = await createRenderJob({
    planId: id,
    memberId: gate.member.id,
    params: { view: 'eye-level' },
    planUpdatedAt: plan.updatedAt,
  })

  // Everything from here can fail, and every failure has to close the job before
  // it answers. A job left sitting at QUEUED is a LIVE job, so "one live job per
  // plan" would lock this plan out of pictures entirely until the nightly sweep
  // aged it out, up to a day later.
  let payload: RenderJobPayload
  try {
    const callbackToken = (await getRenderCallbackToken(job.id)) ?? ''
    const built = await buildRenderJobPayload({ jobId: job.id, callbackToken })
    payload = built.payload
    // The storage key is kept on the job rather than taken from the worker's
    // word for it later: the callback writes a Media row from this, and a worker
    // that could nominate the key could point that row anywhere.
    await recordUploadKey(job.id, built.key)
  } catch (error) {
    const message = error instanceof RenderStorageError ? error.message : 'The picture could not be set up.'
    await finishRenderJob(job.id, { error: message })
    return NextResponse.json({ error: message }, { status: 503 })
  }

  try {
    if (renderEnvConfigured()) {
      await dispatchToOwnWorker(payload)
    } else {
      await dispatchToOwnMachine(job.id, payload, config.maxRenderMachines)
    }
  } catch (error) {
    const message =
      error instanceof SplFlyError
        ? error.message
        : 'The picture service did not answer. Please try again shortly.'
    await finishRenderJob(job.id, { error: message })
    return NextResponse.json({ error: message }, { status: 502 })
  }

  await markRenderRunning(job.id)
  await recordEvent('plan.rendered', { planId: id })

  return NextResponse.json({ job: { id: job.id, status: 'RUNNING' } })
}

/** Kept on the job's params blob, which is what that column is for. */
async function recordUploadKey(jobId: string, key: string): Promise<void> {
  const { prisma } = await import('@/lib/db/prisma')
  await prisma.$executeRaw`
    UPDATE "spl_render_jobs"
    SET "params" = "params" || ${JSON.stringify({ uploadKey: key })}::jsonb, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${jobId}
  `
}

/** A worker somebody else runs, named by SPACE_PLANNER_RENDER_URL. Nothing is
 * created and nothing will be destroyed - their machine, their lifecycle. */
async function dispatchToOwnWorker(payload: RenderJobPayload): Promise<void> {
  const url = process.env.SPACE_PLANNER_RENDER_URL
  const secret = process.env.SPACE_PLANNER_RENDER_SECRET
  if (!url || !secret) throw new Error('not configured')

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`worker answered ${response.status}`)
}

/**
 * A machine of this picture's own.
 *
 * The machine id is written down before the job is posted, so a dispatch that
 * fails still leaves something the sweep can find and destroy. Losing track of a
 * running machine is the only failure here that costs money.
 */
async function dispatchToOwnMachine(jobId: string, payload: RenderJobPayload, ceiling: number): Promise<void> {
  const target = await createRenderMachine(jobId, ceiling)
  await setRenderMachine(jobId, target.machineId)

  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.workerToken}`,
        // Land on THIS machine rather than whichever render is answering the
        // hostname at the time.
        'fly-force-instance-id': target.machineId,
      },
      body: JSON.stringify(payload),
      // The machine is already up by here - createRenderMachine waited for it -
      // so this only has to cover Chromium launching and the worker answering
      // 202, which it does before it draws anything.
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new SplFlyError(`The picture machine would not take the job (HTTP ${response.status}).`)
  } catch (error) {
    await destroyRenderMachine(target.machineId)
    throw error
  }
}
