import { getSiteUrl } from '@/lib/config/env'
import { getQuoteConfigCached, pricesHidden } from '@/modules/quote-for-shop/lib/config'
import { buildQuoteSnapshot } from '@/modules/quote-for-shop/lib/snapshot'
import { createQuote } from '@/modules/quote-for-shop/lib/db/quotes'
import { sendQuoteAlertToOwner, sendQuoteRequestAck } from '@/modules/quote-for-shop/lib/email'
import { planToCartLines } from '@/modules/space-planner-for-shop/lib/bom'
import type { PlanItems } from '@/modules/space-planner-for-shop/lib/types'

// Quotes ride quote-for-shop. The planner ships no quote pipeline of its own.
//
// That module already has all of it - numbered quotes, shopper and owner emails,
// an admin inbox with a status flow, an expiry cron and convert-to-order - and a
// second inbox for planner quotes would be a second place for the owner to
// forget to look. So "request a quote for this plan" creates a REQUEST-kind
// quote through quote-for-shop's own creation path, with the item list as its
// priced snapshot and the plan's share link as the source url, and the owner
// deals with it where they already deal with everything else.
//
// The only planner-side state is the quote id on the plan, so the plan can say
// "you asked about this on the fourth" instead of forgetting.

export type PlanQuoteInput = {
  plan: PlanItems
  planId: string
  planName: string
  roomName: string
  shareUrl: string | null
  name: string
  email: string
  phone?: string
  company?: string
  message?: string
  memberId: string | null
}

export type PlanQuoteResult =
  | { ok: true; quoteId: string; quoteNumber: string; code: string; url: string; unavailable: string[] }
  | { ok: false; error: string }

export async function createQuoteFromPlan(input: PlanQuoteInput): Promise<PlanQuoteResult> {
  const lines = planToCartLines(input.plan)
  if (lines.length === 0) return { ok: false, error: 'There is nothing in this layout to quote yet.' }

  const config = await getQuoteConfigCached()
  const snapshot = await buildQuoteSnapshot(lines, { customerEmail: input.email })
  if (snapshot.lines.length === 0) {
    return { ok: false, error: 'Nothing in this layout can be quoted at the moment.' }
  }

  // The plan itself is the context the owner needs to answer sensibly, so the
  // link goes in the message as well as in source_url - the inbox shows the
  // message, and an owner reading it on a phone should not have to go looking
  // for a field.
  const planLink = input.shareUrl ? `${getSiteUrl()}${input.shareUrl}` : ''
  const message = [
    input.message?.trim(),
    `Room: ${input.roomName} - layout "${input.planName}"`,
    planLink ? `Plan: ${planLink}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  // The owner's own setting, in days, and no arithmetic of our own on top of it:
  // a stray doubling here quietly gave every plan quote twice the validity the
  // quote module says it has, on the quote module's own printed document.
  const expiresAt = config.expiryDays > 0
    ? new Date(Date.now() + config.expiryDays * 24 * 60 * 60 * 1000)
    : null

  const quote = await createQuote({
    kind: 'REQUEST',
    customerName: input.name.trim(),
    customerEmail: input.email.trim(),
    customerPhone: input.phone?.trim() ?? '',
    company: input.company?.trim() ?? '',
    message,
    currency: snapshot.currency,
    currencySymbol: snapshot.currencySymbol,
    lines: snapshot.lines,
    totals: snapshot.totals,
    cart: snapshot.lines.map((line) => ({
      productId: line.productId as string,
      quantity: line.quantity,
      ...(line.lineId ? { lineId: line.lineId } : {}),
      ...(line.meta ? { meta: line.meta } : {}),
    })),
    pricesHidden: pricesHidden(config),
    memberId: input.memberId,
    sourceUrl: planLink,
    expiresAt,
    quoteNumberPrefix: config.quoteNumberPrefix,
  })

  await sendQuoteRequestAck(quote)
  await sendQuoteAlertToOwner(quote)

  return {
    ok: true,
    quoteId: quote.id,
    quoteNumber: quote.quoteNumber,
    code: quote.code,
    url: `/quote/${quote.code.replace('-', '')}`,
    unavailable: snapshot.unavailable.map((entry) =>
      typeof entry === 'string' ? entry : `${entry.name} (${entry.reason})`,
    ),
  }
}
