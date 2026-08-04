import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { getQuoteConfigCached, pricesHidden } from '@/modules/quote-for-shop/lib/config'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import { getPlanForMember, listPlansForMember } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { buildBom } from '@/modules/space-planner-for-shop/lib/bom'
import { buildPlanExportHtml } from '@/modules/space-planner-for-shop/lib/export-doc'
import type { QuotePageInput } from '@/modules/space-planner-for-shop/lib/export-doc'
import { PlanPdfUnavailableError, planPdfFilename, renderPlanPdf, siteUrl } from '@/modules/space-planner-for-shop/lib/pdf'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { countRecentEvents, recordEvent } from '@/modules/space-planner-for-shop/lib/db/events'

// "Export to PDF."
//
// What used to be a Print button, which asked the browser to print the
// application - toolbars, panels, a canvas at whatever size the window happened
// to be - and hoped. This composes the document instead: the room's numbers, the
// drawings the shopper is looking at, the priced item list, and the quote page
// if they want one.
//
// The drawings arrive from the browser as data URLs rather than being redrawn
// here, and that is the whole reason this exists as a POST. The flat plan is a
// 2D canvas and the 3D view is WebGL; both are pictures of a state that lives in
// the shopper's tab, at the zoom and the angle THEY chose. Rendering our own
// would produce a document showing a room nobody was looking at.
//
// Prices are never taken from the browser. The item list is built here, from the
// saved plan, through shop's own price resolution - the same rule the quote
// route follows and for the same reason.
//
// MEMBER tier, and rate limited, because every call starts a headless browser.

/** A picture the browser took: a PNG data URL, and not a large one. */
const DataUrl = z
  .string()
  .max(6_000_000)
  .refine((value) => /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value), 'That is not a picture')

const Body = z.object({
  includePlanView: z.boolean().default(true),
  include3dView: z.boolean().default(false),
  includeQuote: z.boolean().default(false),
  planImage: DataUrl.nullable().optional(),
  viewImage: DataUrl.nullable().optional(),
})

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error?.issues[0]?.message ?? 'That did not look right.' }, { status: 400 })
  }

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const room = await getRoomForMember(plan.roomId, gate.member.id)
  if (!room) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Same shape of limit as renders and plan emails, and for the same reason:
  // this one launches a browser.
  const config = await getSplConfigCached()
  const mine = await listPlansForMember(gate.member.id)
  const recent = await countRecentEvents('plan.exported', mine.map((entry) => entry.id), config.rateLimitWindowMin)
  if (recent >= config.maxRendersPerWindow) {
    return NextResponse.json(
      { error: 'You have made a few of these just now. Give those a moment and try again.' },
      { status: 429 },
    )
  }

  const [bom, site] = await Promise.all([
    buildBom(plan.items, plan.productSnapshot),
    prisma.siteConfig.findUnique({ where: { id: 'singleton' }, select: { siteName: true } }),
  ])

  // The quote page is the quote module's, in the sense that matters: its
  // heading, its intro, its terms, its validity note and its rule about whether
  // prices are shown at all. The planner does not have opinions about how this
  // shop words a quote, and it is not about to grow any.
  let quote: QuotePageInput | null = null
  if (parsed.data.includeQuote) {
    const quoteConfig = await getQuoteConfigCached()
    quote = {
      heading: quoteConfig.documentHeading,
      intro: quoteConfig.documentIntro,
      terms: quoteConfig.terms,
      validity: quoteConfig.validityNote,
      reference: plan.quoteId ? await quoteNumberFor(plan.quoteId) : null,
      pricesHidden: pricesHidden(quoteConfig),
      hiddenPriceLabel: quoteConfig.hiddenPriceLabel,
    }
  }

  const html = buildPlanExportHtml({
    roomName: room.name,
    planName: plan.name,
    geometry: room.geometry,
    bom,
    siteName: site?.siteName ?? '',
    planImage: parsed.data.includePlanView ? parsed.data.planImage ?? null : null,
    viewImage: parsed.data.include3dView ? parsed.data.viewImage ?? null : null,
    quote,
    dateLabel: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    planUrl: plan.shareToken ? siteUrl(`/space-planner/shared/${plan.shareToken}`) : null,
  })

  try {
    const pdf = await renderPlanPdf(html)
    await recordEvent('plan.exported', { planId: id })
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${planPdfFilename(room.name, plan.name)}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    // An unavailable browser is a site setup problem, not a shopper problem, so
    // it says so in a sentence rather than arriving as a five hundred.
    if (error instanceof PlanPdfUnavailableError) {
      return NextResponse.json({ error: 'PDFs are not set up on this site yet.', detail: error.message }, { status: 503 })
    }
    return NextResponse.json({ error: 'We could not make that PDF just now. Please try again shortly.' }, { status: 502 })
  }
}

/**
 * The quote's own number, when this plan has already been quoted.
 *
 * Read straight rather than through quote-for-shop's readers: all this needs is
 * one column, and every one of those takes a code or an admin session.
 */
async function quoteNumberFor(quoteId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ quote_number: string }[]>`
    SELECT "quote_number" FROM "qfs_quotes" WHERE "id" = ${quoteId} LIMIT 1
  `
  return rows[0]?.quote_number ?? null
}
