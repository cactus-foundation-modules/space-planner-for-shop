import { polygonAreaM2, walls } from '@/modules/space-planner-for-shop/lib/geometry'
import { formatLength } from '@/modules/space-planner-for-shop/lib/units'
import type { Bom } from '@/modules/space-planner-for-shop/lib/bom'
import type { RoomGeometry } from '@/modules/space-planner-for-shop/lib/types'

// The exported document, as one self-contained HTML string.
//
// Self-contained is the whole design: every style is inline, the drawings arrive
// as data URLs and there is not a single request for the print browser to wait
// on. A PDF that sometimes comes out without the floor plan because a stylesheet
// was slow is worse than no PDF at all, and it fails in front of the customer
// rather than in front of us.
//
// It prints in ink on paper rather than in the site's theme. The planner follows
// the shop's colour tokens on screen, which on a dark theme means white text -
// and white text on white paper is a blank page that took thirty seconds to
// produce.

export type PlanExportInput = {
  roomName: string
  planName: string
  geometry: RoomGeometry
  bom: Bom
  siteName: string
  /** The site's logo as a data URL, inlined by the route so the print browser
   * never waits on a network. Null when the site has none. */
  logoDataUrl?: string | null
  /** The flat plan, as a data URL. Omitted when the shopper unticked it. */
  planImage?: string | null
  /** The 3D view, as a data URL. Omitted when the shopper unticked it. */
  viewImage?: string | null
  /** The saved views the shopper ticked, each photographed from its own spot. */
  savedViews?: Array<{ name: string; image: string }>
  /**
   * Whether this shop shows prices at all.
   *
   * A shop-wide decision, so it governs the item list on page one and not only
   * the quote page - the two disagreeing inside one document was how a
   * quote-only shop ended up posting its own trade prices out.
   */
  hidePrices?: boolean
  /** What stands in for a price when they are hidden. The shop's own wording. */
  hiddenPriceLabel?: string
  /** The quote page, when it was asked for. Null leaves it out entirely. */
  quote?: QuotePageInput | null
  /** Today, formatted by the caller - nothing here reads the clock. */
  dateLabel: string
  planUrl: string | null
}

/**
 * Everything the quote page needs, taken from quote-for-shop's own settings.
 *
 * The wording is the owner's, written once in the quote module and used by the
 * quote document, the quote emails and now this - because a shop that has
 * already said how it talks about quotes should not have to say it again here.
 */
export type QuotePageInput = {
  heading: string
  intro: string
  terms: string
  validity: string
  /** The real quote number, when this plan has already been through the quote flow. */
  reference: string | null
  pricesHidden: boolean
  hiddenPriceLabel: string
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Paragraphs from a settings textarea, escaped, blank lines dropped. */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

const STYLES = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 11pt/1.45 -apple-system, "Segoe UI", system-ui, sans-serif; color: #16181a; }
  h1 { font-size: 20pt; margin: 0 0 2mm; }
  h2 { font-size: 13pt; margin: 0 0 2mm; }
  p { margin: 0 0 3mm; }
  .muted { color: #55595e; }
  .small { font-size: 9pt; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 8mm; border-bottom: 1px solid #d5d8dc; padding-bottom: 3mm; margin-bottom: 5mm; }
  .figure { margin: 0 0 6mm; }
  .figure img { width: 100%; height: auto; border: 1px solid #d5d8dc; border-radius: 2mm; }
  .figure figcaption { margin-top: 1.5mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 1.8mm 2mm; border-bottom: 1px solid #e2e5e8; text-align: left; vertical-align: top; }
  th { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.03em; color: #55595e; }
  .num { text-align: right; white-space: nowrap; }
  tfoot td { border-bottom: none; border-top: 1.5px solid #16181a; font-weight: 600; }
  .facts { display: flex; gap: 6mm; flex-wrap: wrap; margin: 0 0 5mm; padding: 0; list-style: none; }
  .facts li { font-size: 10pt; }
  .facts strong { display: block; font-size: 13pt; }
  /* A page break the print engine honours, used only between real sections. */
  .page-break { break-before: page; page-break-before: always; }
  /* Rows never split across a page: half a desk at the foot of page one and its
     price at the top of page two is how a priced list stops being readable. */
  tr, .figure { break-inside: avoid; page-break-inside: avoid; }

  /* The quote page, styled to read as the same document quote-for-shop prints
     from the cart. Copied values, not imported code: a dependent module never
     reaches into the module it depends on, and this page prints in ink whatever
     theme the site wears - the same #111/#444/#ccc the quote document's own
     print rules force. */
  .q-head { display: flex; flex-wrap: wrap; gap: 8mm; justify-content: space-between; align-items: flex-start; padding-bottom: 4mm; border-bottom: 1px solid #ccc; margin-bottom: 4mm; }
  .q-brand { display: flex; align-items: center; gap: 3mm; }
  .q-logo { max-height: 13mm; max-width: 52mm; width: auto; height: auto; }
  .q-site { font-weight: 600; font-size: 12pt; }
  .q-meta { text-align: right; margin-left: auto; }
  .q-meta h1 { font-size: 16pt; margin: 0 0 2mm; }
  .q-facts { display: grid; grid-template-columns: auto auto; gap: 0.5mm 3mm; margin: 0; font-size: 10pt; justify-content: end; }
  .q-facts dt { color: #55595e; }
  .q-facts dd { margin: 0; font-variant-numeric: tabular-nums; }
  .q-lines { width: 100%; border-collapse: collapse; margin: 4mm 0 0; font-size: 10.5pt; }
  .q-lines th { text-align: left; padding: 2mm 2mm 2mm 0; border-bottom: 1px solid #ccc; color: #55595e; font-weight: 600; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.02em; }
  .q-lines td { padding: 2.2mm 2mm 2.2mm 0; border-bottom: 1px solid #e2e5e8; vertical-align: top; }
  .q-lines th:last-child, .q-lines td:last-child { padding-right: 0; }
  .q-name { display: block; font-weight: 500; }
  .q-sku { display: block; font-size: 8.5pt; color: #55595e; }
  .q-detail { list-style: none; margin: 1mm 0 0; padding: 0; display: grid; gap: 0.5mm; font-size: 8.5pt; color: #55595e; }
  .q-totals { display: grid; grid-template-columns: 1fr auto; gap: 1mm 6mm; margin: 4mm 0 0 auto; max-width: 80mm; font-size: 10.5pt; }
  .q-totals dt { color: #55595e; }
  .q-totals dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  .q-grand { font-weight: 700; font-size: 12pt; padding-top: 1.5mm; border-top: 1px solid #16181a; }
  .q-poa { margin: 3mm 0 0; color: #55595e; }
  .q-notes { margin: 6mm 0 0; display: grid; gap: 3mm; }
  .q-validity { margin: 0; font-size: 9.5pt; color: #55595e; }
  .q-terms h2 { font-size: 11pt; margin: 0 0 1.5mm; }
  .q-terms p { margin: 0 0 2mm; font-size: 8.5pt; color: #55595e; }
`

function figure(src: string, caption: string): string {
  // The src is a data URL this route validated; the caption is ours.
  return `<figure class="figure"><img src="${src}" alt=""><figcaption class="muted small">${escapeHtml(caption)}</figcaption></figure>`
}

function bomTable(bom: Bom, hidePrices: boolean, hiddenLabel: string): string {
  const rows = bom.lines
    .map(
      (line) => `<tr>
        <td>${escapeHtml(line.name)}${line.approximate ? ' <span class="muted small">(approx. size)</span>' : ''}${
          line.sizeLabel ? `<br><span class="muted small">${escapeHtml(line.sizeLabel)}</span>` : ''
        }</td>
        <td class="num">${line.quantity}</td>
        <td class="num">${hidePrices ? escapeHtml(hiddenLabel) : escapeHtml(line.unitPriceFormatted)}</td>
        <td class="num">${hidePrices ? escapeHtml(hiddenLabel) : escapeHtml(line.lineTotalFormatted)}</td>
      </tr>`,
    )
    .join('')

  const foot = hidePrices
    ? ''
    : `<tfoot><tr><td>Total ${escapeHtml(bom.taxSuffix)}</td><td class="num">${bom.itemCount}</td><td></td><td class="num">${escapeHtml(bom.totalFormatted)}</td></tr></tfoot>`

  return `<table>
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Each</th><th class="num">Total</th></tr></thead>
    <tbody>${rows}</tbody>
    ${foot}
  </table>`
}

/** The room's own numbers, which is what somebody measuring up wants on the sheet. */
function roomFacts(geometry: RoomGeometry, bom: Bom): string {
  const wallList = walls(geometry.vertices)
  const longest = wallList.reduce((best, wall) => (wall.lengthMm > best ? wall.lengthMm : best), 0)
  return `<ul class="facts">
    <li><strong>${polygonAreaM2(geometry.vertices).toFixed(1)} m²</strong><span class="muted">Floor area</span></li>
    <li><strong>${wallList.length}</strong><span class="muted">Walls</span></li>
    <li><strong>${escapeHtml(formatLength(longest, geometry.units))}</strong><span class="muted">Longest wall</span></li>
    <li><strong>${escapeHtml(formatLength(geometry.ceilingMm, geometry.units))}</strong><span class="muted">Ceiling</span></li>
    <li><strong>${bom.itemCount}</strong><span class="muted">Items</span></li>
  </ul>`
}

/**
 * The quote page, on its own sheet, laid out the way quote-for-shop's own quote
 * document prints from the cart: the shop's brand top-left, the heading and the
 * quote's facts top-right, the lines with their codes and sizes, the total
 * bottom-right, and the small print underneath. Somebody who has had a quote
 * from this shop before should not be able to tell the two pages apart at
 * arm's length.
 */
function quotePage(
  input: QuotePageInput,
  bom: Bom,
  brand: { siteName: string; logoDataUrl: string | null; dateLabel: string },
): string {
  const money = !input.pricesHidden
  const rows = bom.lines
    .map(
      (line) => `<tr>
        <td>
          <span class="q-name">${escapeHtml(line.name)}</span>
          ${line.sku ? `<span class="q-sku">${escapeHtml(line.sku)}</span>` : ''}
          ${line.sizeLabel ? `<ul class="q-detail"><li>${escapeHtml(line.sizeLabel)}${line.approximate ? ' (approx.)' : ''}</li></ul>` : ''}
        </td>
        <td class="num">${line.quantity}</td>
        ${money ? `<td class="num">${escapeHtml(line.unitPriceFormatted)}</td><td class="num">${escapeHtml(line.lineTotalFormatted)}</td>` : ''}
      </tr>`,
    )
    .join('')

  return `<section class="page-break">
    <header class="q-head">
      <div class="q-brand">
        ${brand.logoDataUrl ? `<img class="q-logo" src="${brand.logoDataUrl}" alt="">` : ''}
        ${brand.siteName ? `<span class="q-site">${escapeHtml(brand.siteName)}</span>` : ''}
      </div>
      <div class="q-meta">
        <h1>${escapeHtml(input.heading)}</h1>
        <dl class="q-facts">
          ${input.reference ? `<dt>Quote</dt><dd>${escapeHtml(input.reference)}</dd>` : ''}
          <dt>Date</dt><dd>${escapeHtml(brand.dateLabel)}</dd>
        </dl>
      </div>
    </header>
    ${paragraphs(input.intro)}
    <table class="q-lines">
      <thead><tr><th>Item</th><th class="num">Qty</th>${money ? '<th class="num">Unit price</th><th class="num">Total</th>' : ''}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${
      money
        ? `<dl class="q-totals"><dt class="q-grand">Total ${escapeHtml(bom.taxSuffix)}</dt><dd class="q-grand">${escapeHtml(bom.totalFormatted)}</dd></dl>`
        : // The quote document's own arrangement for a shop withholding prices:
          // no money columns at all, and a sentence saying what happens next.
          `<p class="q-poa">We will price this list and come back to you.</p>`
    }
    <section class="q-notes">
      ${input.validity ? `<p class="q-validity">${escapeHtml(input.validity)}</p>` : ''}
      ${input.terms ? `<div class="q-terms"><h2>Terms</h2>${paragraphs(input.terms)}</div>` : ''}
    </section>
  </section>`
}

/**
 * Build the whole document.
 *
 * Order is deliberate: what the room is, then what it looks like, then what is
 * in it and what that costs. Somebody handed this on paper reads it top to
 * bottom and stops when they have their answer, and the answer is nearly always
 * on the first page.
 */
export function buildPlanExportHtml(input: PlanExportInput): string {
  const { geometry, bom } = input

  const drawings = [
    input.planImage ? figure(input.planImage, 'The floor plan, to scale.') : '',
    input.viewImage ? figure(input.viewImage, 'The space in three dimensions.') : '',
    ...(input.savedViews ?? []).map((entry) => figure(entry.image, `From "${entry.name}".`)),
  ]
    .filter(Boolean)
    .join('')

  return `<!doctype html>
<html lang="en-GB">
<head><meta charset="utf-8"><title>${escapeHtml(input.roomName)} - ${escapeHtml(input.planName)}</title><style>${STYLES}</style></head>
<body>
  <header class="head">
    <div>
      <h1>${escapeHtml(input.roomName)}</h1>
      <p class="muted" style="margin:0">${escapeHtml(input.planName)}</p>
    </div>
    <div class="muted small" style="text-align:right">
      <div>${escapeHtml(input.siteName)}</div>
      <div>${escapeHtml(input.dateLabel)}</div>
    </div>
  </header>

  ${roomFacts(geometry, bom)}
  ${drawings}

  <section>
    <h2>Everything in the space</h2>
    ${bom.lines.length > 0 ? bomTable(bom, input.hidePrices ?? false, input.hiddenPriceLabel ?? '') : '<p class="muted">Nothing in the space yet.</p>'}
    ${bom.missing.length > 0 ? `<p class="small muted">${escapeHtml(bom.missing.length === 1 ? 'One thing in this layout is no longer in the shop:' : `${bom.missing.length} things in this plan are no longer in the shop:`)} ${escapeHtml(bom.missing.join(', '))}.</p>` : ''}
    <p class="small muted">${escapeHtml(bom.disclaimer)}</p>
    ${input.planUrl ? `<p class="small muted">Open it again at ${escapeHtml(input.planUrl)}</p>` : ''}
  </section>

  ${input.quote ? quotePage(input.quote, bom, { siteName: input.siteName, logoDataUrl: input.logoDataUrl ?? null, dateLabel: input.dateLabel }) : ''}
</body>
</html>`
}
