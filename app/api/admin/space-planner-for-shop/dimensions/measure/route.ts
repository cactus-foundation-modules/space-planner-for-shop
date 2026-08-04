import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSplUser } from '@/modules/space-planner-for-shop/lib/access'
import { listModelledProductIds } from '@/modules/space-planner-for-shop/lib/db/model-meta'
import { resolveModelsForProducts } from '@/modules/space-planner-for-shop/lib/model-resolver'
import { applyMeasurements } from '@/modules/space-planner-for-shop/lib/resolve-dimensions'

// The measuring pass: rung 1 of the size ladder, finally reachable.
//
// The ladder has always said the mesh is truth where there is a mesh, and for
// three releases nothing ever wrote one of those rows - so the planner sized a
// catalogue of real, modelled furniture off free-text spec columns, and drew
// whatever they said. A supplier writing "66.5-131.5cm" made a desk 67 mm tall.
//
// The measuring cannot happen here. A route has sixty seconds and these files
// average four megabytes, so a couple of hundred of them is not a request, it is
// an afternoon. It happens in the ADMIN'S BROWSER instead, with the very code
// that draws them - which is the useful part, not a compromise: the number
// banked is the extent of the mesh the planner actually puts in the room, node
// transforms, yaw correction and all.
//
//   GET  - the work list: every modelled product, with a signed url and the
//          file's own fix-ups.
//   POST - measurements coming back, in batches.

export const dynamic = 'force-dynamic'

const Body = z.object({
  measurements: z
    .array(
      z.object({
        productId: z.string().min(1).max(64),
        widthMm: z.number().finite(),
        depthMm: z.number().finite(),
        heightMm: z.number().finite(),
      }),
    )
    .min(1)
    .max(200),
})

export async function GET() {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error

  const ids = await listModelledProductIds()
  const models = await resolveModelsForProducts(ids, { withFabric: false })

  return NextResponse.json({
    models: [...models.values()].map((model) => ({
      productId: model.productId,
      url: model.fetchUrl,
      cacheKey: model.plainUrl,
      format: model.format,
      yawOffsetDeg: model.yawOffsetDeg,
    })),
  })
}

export async function POST(request: NextRequest) {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Bad request' }, { status: 400 })

  const result = await applyMeasurements(parsed.data.measurements)
  return NextResponse.json(result)
}
