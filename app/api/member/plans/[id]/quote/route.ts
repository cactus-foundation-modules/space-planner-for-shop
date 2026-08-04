import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { recordMemberActivity } from '@/lib/members/activity'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { getPlanForMember, setPlanShare, updatePlan } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { createQuoteFromPlan } from '@/modules/space-planner-for-shop/lib/quote'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { countRecentEvents, recordEvent } from '@/modules/space-planner-for-shop/lib/db/events'
import { listPlansForMember } from '@/modules/space-planner-for-shop/lib/db/plans'
import { verifyTurnstile } from '@/lib/auth/turnstile'

// "Request a quote for this plan."
//
// The quote itself belongs to quote-for-shop - see lib/quote.ts for why there is
// no quote table here. This route's own jobs are the three the module cannot
// delegate: prove the plan is theirs, hold the rate limit, and make sure the
// owner receives a link they can actually open.

const Body = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200),
  phone: z.string().max(60).optional(),
  company: z.string().max(160).optional(),
  message: z.string().max(4000).optional(),
  turnstileToken: z.string().max(4000).optional(),
})

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const config = await getSplConfigCached()
  if (!config.quoteEnabled) {
    return NextResponse.json({ error: 'Quotes are switched off at the moment.' }, { status: 403 })
  }

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error?.issues[0]?.message ?? 'Please check the form and try again.' }, { status: 400 })
  }

  // Only when it is configured, exactly as contact-form gates its own submission.
  const turnstileOk = await verifyTurnstile(parsed.data.turnstileToken ?? '')
  if (!turnstileOk) {
    return NextResponse.json({ error: 'That did not go through. Please try again.' }, { status: 400 })
  }

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const room = await getRoomForMember(plan.roomId, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const mine = await listPlansForMember(gate.member.id)
  const recent = await countRecentEvents('plan.quoted', mine.map((p) => p.id), config.rateLimitWindowMin)
  if (recent >= config.maxQuotesPerWindow) {
    return NextResponse.json({ error: 'You have sent us a few of these just now. Give us a chance to read them and try again shortly.' }, { status: 429 })
  }

  // A quote the owner cannot open is a quote they cannot answer, so the plan is
  // shared as part of asking - it is being sent to the shop on purpose.
  const token = plan.shareToken ?? (await setPlanShare(id, gate.member.id, true))

  const result = await createQuoteFromPlan({
    plan: plan.items,
    planId: plan.id,
    planName: plan.name,
    roomName: room.name,
    shareUrl: token ? `/space-planner/shared/${token}` : null,
    name: parsed.data.name,
    email: parsed.data.email,
    phone: parsed.data.phone,
    company: parsed.data.company,
    message: parsed.data.message,
    memberId: gate.member.id,
  })

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  await updatePlan(id, gate.member.id, { quoteId: result.quoteId })
  await recordEvent('plan.quoted', { planId: id })
  await recordMemberActivity(gate.member.id, 'space-planner.plan-quoted', {
    source: 'space-planner-for-shop',
    metadata: { planId: id, quoteNumber: result.quoteNumber },
  }).catch(() => {})

  return NextResponse.json({
    quoteNumber: result.quoteNumber,
    code: result.code,
    url: result.url,
    unavailable: result.unavailable,
  })
}
