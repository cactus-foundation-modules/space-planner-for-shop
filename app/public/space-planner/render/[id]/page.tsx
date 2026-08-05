import { notFound } from 'next/navigation'
import { getRenderJob } from '@/modules/space-planner-for-shop/lib/db/jobs'
import { getPlanForAdmin } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForAdmin } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { resolveModelsForProducts } from '@/modules/space-planner-for-shop/lib/model-resolver'
import { buildScene, type ResolvedModel } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import { verifyRenderPageToken } from '@/modules/space-planner-for-shop/lib/render-dispatch'
import { readSavedCamera } from '@/modules/space-planner-for-shop/lib/validation'
import { RenderFrame } from '@/modules/space-planner-for-shop/components/public/RenderFrame'

// The page the picture is a photograph OF.
//
// This exists so there is exactly one renderer. The worker is a browser with a
// screenshot button; everything about how a room looks - the lighting, the
// placeholders, the wall fade, the materials - is decided here, by the same code
// the shopper was looking at when they pressed the button. A worker that drew
// the room itself would be a second implementation, and the day the two
// disagreed would be months after anybody could remember there were two.
//
// Nobody navigates here. It answers to a signed, short-lived token bound to one
// job, and it is robots-disallowed.
//
// It does NOT, however, get to be a bare page, and BLANKING_CSS below is the
// apology for having assumed otherwise. Module public pages hang off the core
// public catch-all, so this renders inside app/(public)/layout.tsx along with
// the site header, the footer and - because the worker's browser is brand new
// and has consented to nothing - the cookie bar. Every photograph taken before
// this had all three sitting on top of the room. There is no full-screen opt-out
// to reach for, so the page hides its own siblings instead.

export const dynamic = 'force-dynamic'

/**
 * Everything in the document that is not this page.
 *
 * Server-rendered rather than applied on mount, because the worker is a browser
 * that screenshots as soon as the scene says it is ready, and a header that
 * disappears one frame after the shutter is a header in the photograph.
 *
 * `body > *:not(main)` is deliberately blunt: the header, footer and consent
 * banner are all direct children of body (the public layout returns a fragment),
 * and so is anything Next or a future banner decides to append. Naming them
 * individually would work today and quietly stop working the first time one of
 * them moved.
 */
const BLANKING_CSS = `
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    background: #000 !important;
  }
  body > *:not(main) { display: none !important; }
  main {
    display: block !important;
    margin: 0 !important;
    padding: 0 !important;
    max-width: none !important;
    width: 100% !important;
  }
`

export function generateMetadata() {
  return { title: 'Rendering', robots: { index: false, follow: false } }
}

export default async function RenderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ token?: string }>
}) {
  const { id } = await params
  const { token } = await searchParams
  if (!token || !verifyRenderPageToken(id, token)) notFound()

  const job = await getRenderJob(id)
  if (!job) notFound()
  // A job that has already been answered for is not re-photographed. Without
  // this, a token still inside its half hour is a free render on request.
  if (job.status !== 'QUEUED' && job.status !== 'RUNNING') notFound()

  const plan = await getPlanForAdmin(job.planId)
  if (!plan) notFound()
  const room = await getRoomForAdmin(plan.roomId)
  if (!room) notFound()

  const config = await getSplConfigCached()
  const productIds = [...new Set(plan.items.items.filter((item) => !item.staged).map((item) => item.productId))]
  const models = await resolveModelsForProducts(productIds)

  // Two shapes of the same thing: the scene description is built from the
  // query-stripped urls (which are the cache keys and never expire), while the
  // browser is handed freshly signed ones to actually fetch.
  const resolved = new Map<string, ResolvedModel>()
  for (const [productId, model] of models) {
    resolved.set(productId, {
      productId,
      plainUrl: model.plainUrl,
      format: model.format,
      yawOffsetDeg: model.yawOffsetDeg,
      noDecimation: model.noDecimation,
      fabricKey: model.fabricKey,
    })
  }
  const description = buildScene(room.geometry, plan.items, plan.productSnapshot, resolved)

  const sources = [...models.values()].map((model) => ({
    productId: model.productId,
    url: model.fetchUrl,
    cacheKey: model.plainUrl,
    format: model.format,
    yawOffsetDeg: model.yawOffsetDeg,
    noDecimation: model.noDecimation,
    fabricKey: model.fabricKey,
    slots: model.slots,
  }))

  // Null on an old job, or on one whose stored pose will not parse. Both fall
  // back to the canned standpoint rather than refusing to draw - a picture from
  // the wrong angle beats no picture and a machine already paid for.
  const camera = readSavedCamera((job.params as { camera?: unknown }).camera)

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: BLANKING_CSS }} />
      <RenderFrame
        description={description}
        sources={sources}
        camera={camera}
        options={{
          yawOffsetDeg: 0,
          // Nothing is decimated for a picture. Decimation exists so a phone can
          // hold a room in memory at sixty frames a second; this machine has
          // sixteen gigabytes and one frame to draw.
          noDecimation: true,
          decimationTarget: 1,
          textureMaxPx: 4096,
          maxUniqueModels: Math.max(config.maxUniqueModels, 64),
        }}
      />
    </>
  )
}
