import { notFound } from 'next/navigation'
import { getRenderJob } from '@/modules/space-planner-for-shop/lib/db/jobs'
import { getPlanForAdmin } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForAdmin } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { resolveModelsForProducts } from '@/modules/space-planner-for-shop/lib/model-resolver'
import { buildScene, type ResolvedModel } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import { verifyRenderPageToken } from '@/modules/space-planner-for-shop/lib/render-dispatch'
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
// job, it is robots-disallowed, and it has no chrome, no controls and no way
// back into the site.

export const dynamic = 'force-dynamic'

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
  }))

  return (
    <RenderFrame
      description={description}
      sources={sources}
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
  )
}
