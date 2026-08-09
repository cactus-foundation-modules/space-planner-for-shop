import { NextRequest, NextResponse } from 'next/server'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { getPlanForMember } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import {
  countRecentRendersForMember,
  createRenderJob,
  failStaleRenderJobs,
  finishRenderJob,
  getLiveRenderForPlan,
  getRenderCallbackToken,
  listRendersForPlan,
  markRenderRunning,
  RenderAlreadyLiveError,
  setRenderMachine,
} from '@/modules/space-planner-for-shop/lib/db/jobs'
import { getSplConfigCached, renderEnvConfigured, renderWorkerConfigured } from '@/modules/space-planner-for-shop/lib/config'
import { recordEvent } from '@/modules/space-planner-for-shop/lib/db/events'
import { buildRenderJobPayload, type RenderJobPayload } from '@/modules/space-planner-for-shop/lib/render-dispatch'
import { payloadTooLarge, readSavedCamera } from '@/modules/space-planner-for-shop/lib/validation'
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

/**
 * What a shopper is told when a picture will not start, whatever went wrong.
 *
 * One sentence, on purpose. What the hosting provider actually said - a missing
 * key, an HTTP 403, an app that would not answer - names somebody else's
 * plumbing and, in the missing-key case, is an instruction addressed to the site
 * owner. None of it means anything to a customer.
 *
 * The real reason is still written to the job, because the render log in the
 * admin is where the owner finds out their picture service is broken, and it is
 * sanitised on the way OUT to a member instead - here and in the poll below.
 */
const CANNOT_START_PICTURE = 'We could not start that picture just now. Please try again in a few minutes.'

/**
 * A stored failure, worded for the shopper.
 *
 * The two messages that describe a wait rather than a fault are kept: they end
 * in "try again in a moment", which is advice a customer can act on. Everything
 * else becomes the one sentence.
 */
function shopperError(stored: string): string {
  if (!stored) return ''
  const safe = [
    'Quite a few pictures are being made at the moment. Give it a minute and ask again.',
    'The picture machine took too long to start. Please try again in a moment.',
  ]
  return safe.includes(stored) ? stored : CANNOT_START_PICTURE
}

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
      // Sanitised here rather than at the point it was stored, so the admin's
      // render log keeps the real reason.
      error: shopperError(job.error),
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

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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

  // Age out anything the worker never came back from, before deciding whether a
  // picture is already on the way. Only the nightly sweep used to do this, and
  // "one live job per plan" is enforced by a database index now - so a worker
  // that crashed at nine in the morning locked that layout out of pictures until
  // twenty past three the next morning, with nothing the owner could do about
  // it. Bounded, indexed on status, and almost always a no-op.
  await failStaleRenderJobs()

  // One live job per plan. Asking twice returns the job already running rather
  // than starting a second one and paying for both.
  const live = await getLiveRenderForPlan(id)
  if (live) return NextResponse.json({ job: { id: live.id, status: live.status } })

  // Counted off the jobs this member owns rather than off the event log, which
  // carries no member and was therefore counted against their CURRENT plan ids -
  // so deleting a plan orphaned its events and bought a fresh allowance of
  // machine time.
  const recent = await countRecentRendersForMember(gate.member.id, config.rateLimitWindowMin)
  if (recent >= config.maxRendersPerWindow) {
    return NextResponse.json({ error: 'You have asked for a few pictures just now. Give those a moment and try again.' }, { status: 429 })
  }

  // Where they were standing. Optional, and a body that will not parse is
  // treated as "they did not say" rather than as an error: the fallback is the
  // canned standpoint every picture used to be taken from, so the worst case is
  // the behaviour this route had before it learned about cameras.
  const raw = await request.text()
  const camera = payloadTooLarge(raw) ? null : readSavedCamera((safeJson(raw) as { camera?: unknown } | null)?.camera)

  let job
  try {
    job = await createRenderJob({
      planId: id,
      memberId: gate.member.id,
      params: {
        ...(camera ? { view: 'saved-camera', camera } : { view: 'eye-level' }),
        // The layout as it is at THIS moment, travelling with the job.
        //
        // A render is a photograph of a moment, and `plan_updated_at` above is
        // the moment it claims. The page the worker photographs used to read the
        // live rows, so a shopper who pressed the button, was told to close the
        // dialog, and then dragged a desk while the machine cold-started got a
        // picture of the layout they had just changed to, stamped with the date
        // of the one they asked for, described in the email as showing the room
        // "as it was", and offered a re-render of the picture they were already
        // looking at. Reshape the room in that window and the photograph is of a
        // room they never asked to photograph, from a viewpoint chosen for a
        // different shape.
        scene: { items: plan.items, productSnapshot: plan.productSnapshot, geometry: room.geometry },
      },
      planUpdatedAt: plan.updatedAt,
    })
  } catch (error) {
    // The look-before-you-book above lost a race with another tab or another
    // tap. The database refused the second job, which is the answer we wanted -
    // so hand back the one that is already running, exactly as the check does.
    if (error instanceof RenderAlreadyLiveError) {
      const running = await getLiveRenderForPlan(id)
      if (running) return NextResponse.json({ job: { id: running.id, status: running.status } })
      return NextResponse.json({ error: 'A picture of this layout is already being made.' }, { status: 409 })
    }
    throw error
  }

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
    console.error('[space-planner] the render job could not be set up', { jobId: job.id, planId: id, error })
    // The REAL reason is banked on the job. The render log in the admin is the
    // one place the owner finds out that their picture service is broken, and
    // filing the customer's sentence there would leave them reading "we could
    // not start that picture" about their own misconfigured storage.
    await finishRenderJob(job.id, { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: CANNOT_START_PICTURE }, { status: 503 })
  }

  try {
    if (renderEnvConfigured()) {
      await dispatchToOwnWorker(payload)
    } else {
      await dispatchToOwnMachine(job.id, payload, config.maxRenderMachines)
    }
  } catch (error) {
    console.error('[space-planner] the render job could not be dispatched', { jobId: job.id, planId: id, error })
    await finishRenderJob(job.id, { error: error instanceof Error ? error.message : String(error) })
    // Two of these are worth saying to the shopper in their own words - the
    // queue is full, or the machine took too long - because they describe a
    // wait rather than a fault and asking again in a minute genuinely helps.
    // Anything else names our hosting provider at somebody who came here to buy
    // a desk.
    const shopperSafe = error instanceof SplFlyError && error.shopperSafe ? error.message : CANNOT_START_PICTURE
    return NextResponse.json({ error: shopperSafe }, { status: 502 })
  }

  await markRenderRunning(job.id)
  await recordEvent('plan.rendered', { planId: id })

  return NextResponse.json({ job: { id: job.id, status: 'RUNNING' } })
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
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
