import { describe, expect, it } from 'vitest'
import { buildPlanExportHtml, escapeHtml } from '@/modules/space-planner-for-shop/lib/export-doc'
import { defaultRoomGeometry } from '@/modules/space-planner-for-shop/lib/types'
import type { Bom } from '@/modules/space-planner-for-shop/lib/bom'

// The exported document is built by joining strings, which is the one place in
// this module where an escaping slip becomes markup in somebody's PDF. Every
// value here is under the customer's control - they name the room, they name the
// layout, and the product names come out of a catalogue somebody else types.
//
// The price tests are the other half. A shop that has chosen to hide its prices
// hides them on EVERY page of one document, which page one did not always do.

const NASTY = `<script>alert('x')</script>`
const BREAKOUT = `Smith" onerror="alert(1)`

function bom(overrides: Partial<Bom> = {}): Bom {
  return {
    lines: [
      {
        productId: 'p1',
        name: `Desk ${NASTY}`,
        sku: `SKU ${BREAKOUT}`,
        slug: 'desk',
        quantity: 2,
        unitPrice: 100,
        unitPriceFormatted: '£100.00',
        lineTotal: 200,
        lineTotalFormatted: '£200.00',
        sizeLabel: '1600 × 800 × 730 mm',
        approximate: true,
        fromSnapshot: false,
        image: null,
      },
    ],
    itemCount: 2,
    total: 200,
    totalFormatted: '£200.00',
    currencySymbol: '£',
    taxSuffix: 'inc. VAT',
    disclaimer: `Guidance only ${NASTY}`,
    missing: [`Retired thing ${NASTY}`],
    pricesHidden: false,
    ...overrides,
  }
}

function build(overrides: Partial<Parameters<typeof buildPlanExportHtml>[0]> = {}): string {
  return buildPlanExportHtml({
    roomName: `Room ${NASTY}`,
    planName: `Plan ${BREAKOUT}`,
    geometry: defaultRoomGeometry(),
    bom: bom(),
    siteName: `Shop ${NASTY}`,
    logoDataUrl: null,
    planImage: null,
    viewImage: null,
    savedViews: [{ name: `View ${NASTY}`, image: 'data:image/png;base64,AAAA' }],
    dateLabel: '9 August 2026',
    planUrl: null,
    ...overrides,
  })
}

describe('escapeHtml', () => {
  it('escapes everything that can change the meaning of markup', () => {
    expect(escapeHtml(`<>&"`)).toBe('&lt;&gt;&amp;&quot;')
  })
})

describe('the exported document', () => {
  it('never emits a raw script tag, whatever anything is called', () => {
    const html = build()
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('does not let a quotation mark break out of an attribute', () => {
    expect(build()).not.toContain('onerror="alert(1)"')
  })

  it('escapes the quote page as well as the item list', () => {
    const html = build({
      quote: {
        heading: `Quote ${NASTY}`,
        intro: `Intro ${NASTY}`,
        terms: `Terms ${NASTY}`,
        validity: `Valid ${NASTY}`,
        reference: `Q-${NASTY}`,
        pricesHidden: false,
        hiddenPriceLabel: '',
      },
    })
    expect(html).not.toContain('<script>')
  })

  it('prints prices on both pages when the shop shows them', () => {
    const html = build({
      hidePrices: false,
      quote: {
        heading: 'Quote', intro: '', terms: '', validity: '', reference: null,
        pricesHidden: false, hiddenPriceLabel: '',
      },
    })
    // Once on the item list, once on the quote page.
    expect(html.split('£100.00').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('hides prices on page one too when the shop hides them', () => {
    // The defect this pins: page one hardcoded "show the prices" while the quote
    // page honoured the setting, so a quote-only shop posted its own prices out
    // on page one of the very document whose page two withheld them.
    const html = build({
      hidePrices: true,
      hiddenPriceLabel: 'POA',
      quote: {
        heading: 'Quote', intro: '', terms: '', validity: '', reference: null,
        pricesHidden: true, hiddenPriceLabel: 'POA',
      },
    })
    expect(html).not.toContain('£100.00')
    expect(html).not.toContain('£200.00')
    expect(html).toContain('POA')
  })

  it('still lists what is in the room when prices are hidden', () => {
    const html = build({ hidePrices: true, hiddenPriceLabel: 'POA' })
    expect(html).toContain('1600 × 800 × 730 mm')
    expect(html).toContain('&lt;script&gt;')
  })

  it('prints the shop wording when the item list itself says prices are hidden', () => {
    // buildBom now answers "does this shop show prices" once, and every surface
    // that consumes a Bom follows it - the item list, this document, the plan
    // email and the shared page. Only the PDF and the quote used to ask, so a
    // quote-only shop published its list prices on a link anybody could open.
    const hidden = bom({
      lines: [
        {
          productId: 'p1', name: 'Desk', sku: 'SKU', slug: 'desk', quantity: 2,
          unitPrice: 100, unitPriceFormatted: 'POA', lineTotal: 200, lineTotalFormatted: 'POA',
          sizeLabel: '1600 × 800 × 730 mm', approximate: false, fromSnapshot: false, image: null,
        },
      ],
      totalFormatted: 'POA',
      pricesHidden: true,
      missing: [],
    })
    const html = build({ bom: hidden, hidePrices: true, hiddenPriceLabel: 'POA' })

    expect(html).not.toContain('£')
    expect(html).toContain('POA')
    expect(html).toContain('1600 × 800 × 730 mm')
  })

  it('says so when the room is empty rather than printing a headless table', () => {
    const html = build({ bom: bom({ lines: [], itemCount: 0, total: 0, missing: [] }) })
    expect(html).toContain('Nothing in the room yet')
  })
})
