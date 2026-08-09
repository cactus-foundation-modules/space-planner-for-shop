import { getSiteUrl } from '@/lib/config/env'

// Printing a document to PDF with a headless browser.
//
// The shape of this is quote-for-shop's (lib/pdf.ts there), deliberately and
// almost line for line: the same two environments, the same failure modes, the
// same refusals in plain English. It is copied rather than imported because a
// dependent module owns its own surface and never reaches into the module it
// depends on to add an export to it - and because the two want different things
// from the browser. Quotes print a URL, so the PDF is provably the page the
// owner designed. A plan cannot: half of it is a picture of a canvas that only
// exists in the shopper's own browser, so the markup is composed here and handed
// to the browser directly.
//
// Both heavy packages are imported dynamically, so a shop where nobody presses
// the button never loads a browser. They are already declared in next.config.ts
// (serverExternalPackages, and the chromium binary in outputFileTracingIncludes
// under /api/m/**), which is why this needs no build change.

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MAC_CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium'
const LINUX_CHROME = '/usr/bin/google-chrome'
const LINUX_CHROMIUM = '/usr/bin/chromium'

/** True on a serverless/Linux deployment, where the packaged chromium is the one to use. */
function isServerless(): boolean {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL)
}

async function localChromePath(): Promise<string | null> {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const { existsSync } = await import('fs')
  for (const candidate of [MAC_CHROME, MAC_CHROMIUM, LINUX_CHROME, LINUX_CHROMIUM]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export class PlanPdfUnavailableError extends Error {}

/**
 * Print composed HTML to PDF bytes.
 *
 * `setContent` rather than `goto`, because the document carries the shopper's own
 * drawing of their room as an inline image and there is no URL that could serve
 * it. Everything the page needs is in the string: no stylesheet to fetch, no
 * font to wait for, no request that could hang the print.
 */
export async function renderPlanPdf(html: string, opts: { logoDataUrl?: string | null } = {}): Promise<Uint8Array> {
  const [{ default: puppeteer }, chromiumModule] = await Promise.all([
    import('puppeteer-core'),
    isServerless() ? import('@sparticuz/chromium') : Promise.resolve(null),
  ])
  const chromium = chromiumModule?.default ?? null

  let executablePath: string | null = null
  try {
    executablePath = chromium ? await chromium.executablePath() : await localChromePath()
  } catch (error) {
    // The detail goes to the log, not the shopper: a chromium unpack error is
    // full of paths and errno noise that helps nobody outside this process.
    console.error('[space-planner] PDF browser unpack failed:', error)
    throw new PlanPdfUnavailableError('The PDF service could not start just now. Try again in a minute.')
  }
  if (!executablePath) {
    throw new PlanPdfUnavailableError(
      'No browser is available to make a PDF. Install Google Chrome locally, or set CHROME_PATH.',
    )
  }

  let browser
  try {
    browser = await puppeteer.launch({
      executablePath,
      args: chromium ? chromium.args : ['--no-sandbox', '--disable-dev-shm-usage'],
      headless: true,
      // A sheet of A4 at 96dpi, so anything with a breakpoint in it prints its
      // desktop shape rather than its phone one.
      defaultViewport: { width: 794, height: 1123, deviceScaleFactor: 2 },
    })
  } catch (error) {
    console.error('[space-planner] PDF browser launch failed:', error)
    throw new PlanPdfUnavailableError('The PDF service could not start just now. Try again in a minute.')
  }

  try {
    const page = await browser.newPage()
    // 'load' rather than 'networkidle0': the document is self-contained, so
    // there is no network to go idle and waiting for one that never comes is
    // twenty-five seconds of nothing.
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 })
    await page.emulateMediaType('print')
    // The logo rides in the print margin's header box, which chromium repeats
    // on EVERY page - the document below never has to know it is there and can
    // never collide with it. A data URL is the only kind of image a header
    // template will actually load, which is why the route inlines it.
    const logo = opts.logoDataUrl && opts.logoDataUrl.startsWith('data:image/') ? opts.logoDataUrl : null
    return await page.pdf({
      format: 'a4',
      printBackground: true,
      displayHeaderFooter: Boolean(logo),
      headerTemplate: logo
        ? `<div style="width:100%;margin:0 12mm;font-size:1px;"><img src="${logo}" style="height:8mm;max-width:50mm;object-fit:contain;object-position:left;"></div>`
        : '<span></span>',
      footerTemplate: '<span></span>',
      margin: { top: logo ? '20mm' : '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
      preferCSSPageSize: false,
    })
  } finally {
    // Always, even when the print threw: a leaked browser on a warm serverless
    // instance is a memory leak that outlives the request that caused it.
    await browser.close().catch(() => {})
  }
}

/** The filename the shopper's browser saves it as. */
export function planPdfFilename(roomName: string, planName: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${clean(roomName) || 'room'}-${clean(planName) || 'plan'}.pdf`
}

/** Where a link in the document should point. */
export function siteUrl(path: string): string {
  return `${getSiteUrl()}${path}`
}
