import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { finishRenderJob, getRenderCallbackToken, getRenderJob } from '@/modules/space-planner-for-shop/lib/db/jobs'
import { getPlanForAdmin } from '@/modules/space-planner-for-shop/lib/db/plans'
import { sendRenderDoneEmail } from '@/modules/space-planner-for-shop/lib/email'

// The render worker saying it has finished.
//
// PUBLIC tier by necessity - the worker has no session - so the whole of its
// authority is the per-job token minted at enqueue time and handed only to the
// worker. Per job, not per deployment: a single shared secret leaking would let
// anybody overwrite anybody's picture, whereas a per-job token is useless the
// moment that job is done.
//
// The worker uploads the image itself with a signed upload token and tells us
// where it landed; nothing here accepts image bytes.

const Body = z.object({
  jobId: z.string().min(1).max(64),
  token: z.string().min(1).max(200),
  mediaId: z.string().max(64).nullable().optional(),
  url: z.string().max(2000).optional(),
  error: z.string().max(1000).optional(),
})

export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Bad request' }, { status: 400 })

  const expected = await getRenderCallbackToken(parsed.data.jobId)
  if (!expected || !constantTimeEqual(expected, parsed.data.token)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const finished = await finishRenderJob(parsed.data.jobId, {
    mediaId: parsed.data.mediaId ?? null,
    url: parsed.data.url ?? '',
    error: parsed.data.error,
  })
  if (!finished) return NextResponse.json({ ok: true, alreadyFinished: true })

  if (finished.status === 'DONE' && finished.memberId) {
    await notifyMember(finished.id).catch(() => {})
  }

  return NextResponse.json({ ok: true })
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
