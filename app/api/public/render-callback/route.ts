import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { getActiveMediaProvider } from '@/lib/config/env'
import { confirmedSizeBytes, saveMediaRecord } from '@/lib/media/upload'
import { finishRenderJob, getRenderCallbackToken, getRenderJob } from '@/modules/space-planner-for-shop/lib/db/jobs'
import { getPlanForAdmin } from '@/modules/space-planner-for-shop/lib/db/plans'
import { destroyRenderMachine } from '@/modules/space-planner-for-shop/lib/fly/render-worker'
import { sendRenderDoneEmail } from '@/modules/space-planner-for-shop/lib/email'

// The render worker saying it has finished.
//
// PUBLIC tier by necessity - the worker has no session - so the whole of its
// authority is the per-job token minted at enqueue time and handed only to the
// worker. Per job, not per deployment: a single shared secret leaking would let
// anybody overwrite anybody's picture, whereas a per-job token is useless the
// moment that job is done.
//
// The worker uploads the image itself with a signed upload token and says only
// that it is done; nothing here accepts image bytes, and nothing here takes the
// worker's word for WHERE the bytes went - the storage key was decided at
// enqueue time and kept on the job.
//
// This is also where the machine dies. It is the prompt path of the three
// described in lib/fly/render-worker.ts, and the one that runs almost every
// time: picture lands, machine goes, meter stops.

const Body = z.object({
  jobId: z.string().min(1).max(64),
  token: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive().max(200_000_000).optional(),
  error: z.string().max(1000).optional(),
})

export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Bad request' }, { status: 400 })

  const expected = await getRenderCallbackToken(parsed.data.jobId)
  if (!expected || !constantTimeEqual(expected, parsed.data.token)) {
    // Also where a plan deleted mid-render lands: the job row goes with it, so
    // there is no token left to check and the worker's upload is left in the
    // bucket with no library row pointing at it. Deliberately still a 403 -
    // filing media for a job that cannot be authenticated is the one thing this
    // check exists to prevent, and the cost of the alternative is a few stray
    // megabytes on a rare race. The machine is still cleaned up: it is destroyed
    // by its own deadline and by the sweep, neither of which needs this reply.
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Read the job BEFORE finishing it: finishing clears nothing, but the machine
  // id is wanted either way and a second read after the fact is a second query
  // for no reason.
  const job = await getRenderJob(parsed.data.jobId)

  // A job that has already been settled is answered here, before anything is
  // written. Delivery is at-least-once and the token outlives the job, so a
  // retried callback used to reach register() and file a SECOND library row
  // against the same stored object - a row nothing references, which is exactly
  // what the library's unused-media sweep deletes, taking the shared object and
  // the real picture with it. The machine is still destroyed below: the second
  // destroy is free, and a machine left standing is not.
  const settled = Boolean(job && job.status !== 'QUEUED' && job.status !== 'RUNNING')

  let result: { mediaId?: string | null; url?: string; error?: string }
  if (settled) {
    result = {}
  } else if (parsed.data.error) {
    result = { error: parsed.data.error }
  } else {
    result = await register(job?.params, parsed.data.sizeBytes)
  }

  const finished = settled ? null : await finishRenderJob(parsed.data.jobId, result)

  // Whatever happened to the picture, the machine is done with. Destroyed even
  // on a duplicate callback: the second one is free, and a machine still
  // standing is not.
  if (job?.machineId) await destroyRenderMachine(job.machineId)

  if (!finished) return NextResponse.json({ ok: true, alreadyFinished: true })

  if (finished.status === 'DONE' && finished.memberId) {
    await notifyMember(finished.id).catch(() => {})
  }

  return NextResponse.json({ ok: true })
}

/**
 * Write the Media row for bytes that are already in storage.
 *
 * The key comes off the job, never off the request: a worker that could name the
 * key could register a row pointing at any object in the library. The size is
 * confirmed against storage for the same reason the ordinary upload path
 * confirms it - so the library's totals describe the objects rather than
 * somebody's account of them.
 */
async function register(
  params: Record<string, unknown> | undefined,
  sizeBytes: number | undefined,
): Promise<{ mediaId?: string | null; url?: string; error?: string }> {
  const key = typeof params?.uploadKey === 'string' ? params.uploadKey : ''
  if (!key) return { error: 'The picture arrived but the site had lost track of where it was going.' }

  try {
    const provider = await getActiveMediaProvider()
    if (!provider) return { error: 'The picture arrived but media storage is no longer set up.' }

    const confirmed = await confirmedSizeBytes(provider, key, sizeBytes ?? 0)
    if (!confirmed) return { error: 'The picture was reported as done but nothing arrived in storage.' }

    const media = await saveMediaRecord({
      key,
      url: '', // saveMediaRecord rebuilds the serving url for proxied providers
      provider,
      mimeType: 'image/webp',
      sizeBytes: confirmed,
      originalName: 'Space planner picture.webp',
    })
    return { mediaId: media.id, url: media.url }
  } catch (error) {
    return { error: `The picture could not be filed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

async function notifyMember(jobId: string): Promise<void> {
  const job = await getRenderJob(jobId)
  if (!job?.memberId) return
  const plan = await getPlanForAdmin(job.planId)
  if (!plan) return

  const [member, site] = await Promise.all([
    prisma.member.findUnique({ where: { id: job.memberId }, select: { email: true } }),
    prisma.siteConfig.findUnique({ where: { id: 'singleton' }, select: { siteName: true } }),
  ])
  if (!member) return

  await sendRenderDoneEmail({
    to: member.email,
    memberId: job.memberId,
    siteName: site?.siteName ?? 'the shop',
    planName: plan.name,
    planPath: plan.shareToken ? `/space-planner/shared/${plan.shareToken}` : '/space-planner',
    stale: Boolean(job.planUpdatedAt && job.planUpdatedAt.getTime() !== plan.updatedAt.getTime()),
    renderedFor: job.planUpdatedAt ? job.planUpdatedAt.toLocaleDateString('en-GB') : '',
  })
}
