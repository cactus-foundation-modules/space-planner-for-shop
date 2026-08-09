import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { verifyTurnstile } from '@/lib/auth/turnstile'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { getPlanForMember, setPlanShare } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { buildBom } from '@/modules/space-planner-for-shop/lib/bom'
import { sendPlanEmail } from '@/modules/space-planner-for-shop/lib/email'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { countRecentEventsForMember, recordEvent } from '@/modules/space-planner-for-shop/lib/db/events'

// "Email me my plan."
//
// Lead capture for the not-ready-to-buy, and on a fit-out sized order arguably
// worth more than the checkout. It goes to the account address by default and
// takes an override, because the person who drew the room is often not the
// person who holds the budget.

const Body = z.object({
  to: z.string().email().max(200).optional(),
  turnstileToken: z.string().max(4000).optional(),
})

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const config = await getSplConfigCached()
  if (!config.emailPlanEnabled) {
    return NextResponse.json({ error: 'Emailing layouts is switched off at the moment.' }, { status: 403 })
  }

  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'That address did not look right.' }, { status: 400 })

  if (!(await verifyTurnstile(parsed.data.turnstileToken ?? ''))) {
    return NextResponse.json({ error: 'That did not go through. Please try again.' }, { status: 400 })
  }

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const room = await getRoomForMember(plan.roomId, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const recent = await countRecentEventsForMember('plan.emailed', gate.member.id, config.rateLimitWindowMin)
  if (recent >= config.maxPlanEmailsPerWindow) {
    return NextResponse.json({ error: 'That is a lot of emails in a short while. Try again a bit later.' }, { status: 429 })
  }

  const token = plan.shareToken ?? (await setPlanShare(id, gate.member.id, true))
  const bom = await buildBom(plan.items, plan.productSnapshot)
  const site = await prisma.siteConfig.findUnique({ where: { id: 'singleton' }, select: { siteName: true } })

  const sent = await sendPlanEmail({
    to: parsed.data.to ?? gate.member.email,
    siteName: site?.siteName ?? 'the shop',
    roomName: room.name,
    planName: plan.name,
    planPath: token ? `/space-planner/shared/${token}` : '/space-planner',
    bom,
  })

  if (!sent) {
    return NextResponse.json({ error: 'We could not send that just now. Please try again shortly.' }, { status: 502 })
  }

  await recordEvent('plan.emailed', { planId: id, memberId: gate.member.id })
  return NextResponse.json({ ok: true })
}
