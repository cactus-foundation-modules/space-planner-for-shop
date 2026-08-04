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
  /** The flat plan, as a data URL. Omitted when the shopper unticked it. */
  planImage?: string | null
  /** The 3D view, as a data URL. Omitted when the shopper unticked it. */
  viewImage?: string | null
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

function quotePage(input: QuotePageInput, bom: Bom): string {
  return `<section class="page-break">
    <h1>${escapeHtml(input.heading)}</h1>
    ${input.reference ? `<p class="muted">Reference ${escapeHtml(input.reference)}</p>` : ''}
    ${paragraphs(input.intro)}
    ${bomTable(bom, input.pricesHidden, input.hiddenPriceLabel)}
    ${input.validity ? `<p class="small muted" style="margin-top:4mm">${escapeHtml(input.validity)}</p>` : ''}
    ${input.terms ? `<div class="small muted">${paragraphs(input.terms)}</div>` : ''}
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
    input.viewImage ? figure(input.viewImage, 'The room in three dimensions.') : '',
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
    <h2>Everything in the room</h2>
    ${bom.lines.length > 0 ? bomTable(bom, false, '') : '<p class="muted">Nothing in the room yet.</p>'}
    ${bom.missing.length > 0 ? `<p class="small muted">${escapeHtml(bom.missing.length === 1 ? 'One thing in this plan is no longer in the shop:' : `${bom.missing.length} things in this plan are no longer in the shop:`)} ${escapeHtml(bom.missing.join(', '))}.</p>` : ''}
    <p class="small muted">${escapeHtml(bom.disclaimer)}</p>
    ${input.planUrl ? `<p class="small muted">Open it again at ${escapeHtml(input.planUrl)}</p>` : ''}
  </section>

  ${input.quote ? quotePage(input.quote, bom) : ''}
</body>
</html>`
}
