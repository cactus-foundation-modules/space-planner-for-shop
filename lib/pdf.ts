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
export async function renderPlanPdf(html: string): Promise<Uint8Array> {
  const [{ default: puppeteer }, chromiumModule] = await Promise.all([
    import('puppeteer-core'),
    isServerless() ? import('@sparticuz/chromium') : Promise.resolve(null),
  ])
  const chromium = chromiumModule?.default ?? null

  let executablePath: string | null = null
  try {
    executablePath = chromium ? await chromium.executablePath() : await localChromePath()
  } catch (error) {
    throw new PlanPdfUnavailableError(
      `The packaged browser could not be unpacked: ${error instanceof Error ? error.message : String(error)}`,
    )
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
    throw new PlanPdfUnavailableError(
      `The browser would not start: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  try {
    const page = await browser.newPage()
    // 'load' rather than 'networkidle0': the document is self-contained, so
    // there is no network to go idle and waiting for one that never comes is
    // twenty-five seconds of nothing.
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 })
    await page.emulateMediaType('print')
    return await page.pdf({
      format: 'a4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
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
