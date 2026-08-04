import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSplUser } from '@/modules/space-planner-for-shop/lib/access'
import { renderEnvConfigured } from '@/modules/space-planner-for-shop/lib/config'
import { SplFlyError } from '@/modules/space-planner-for-shop/lib/fly/api'
import {
  getRenderWorkerView,
  provisionRenderWorker,
  teardownRenderWorker,
  WORKER_REGIONS,
} from '@/modules/space-planner-for-shop/lib/fly/render-worker'

// Setting up (and taking down) the picture service.
//
// Reading is gated by space-planner.access, so anybody who can see the Pictures
// screen can see whether it works. Making and destroying Fly apps is
// space-planner.manage - it spends money.
//
// The Fly key is a credential and never comes back out of here. The screen is
// told WHERE a key came from ('own', 'media', 'env' or nothing at all), which is
// all it needs to decide between "press this button" and "paste a key in".

export async function GET() {
  const gate = await requireSplUser('space-planner.access', { allowAccess: true })
  if (gate.error) return gate.error

  const view = await getRenderWorkerView()
  return NextResponse.json({ ...view, envOverride: renderEnvConfigured() })
}

const PostSchema = z.object({
  // Absent = borrow whatever key the site already has. Present = save this one
  // and use it from now on.
  token: z.string().min(1).max(500).optional(),
  region: z.enum(WORKER_REGIONS).optional(),
  image: z.string().max(300).optional(),
})

export async function POST(request: NextRequest) {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error

  const parsed = PostSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }

  try {
    await provisionRenderWorker(parsed.data)
  } catch (error) {
    // A Fly refusal is a sentence the owner can act on, so it is passed through
    // as it is. Anything else is ours and gets a generic apology.
    const message = error instanceof SplFlyError ? error.message : 'The picture service could not be set up.'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  return NextResponse.json({ ...(await getRenderWorkerView()), envOverride: renderEnvConfigured() })
}

export async function DELETE() {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error

  const warning = await teardownRenderWorker()
  return NextResponse.json({ ...(await getRenderWorkerView()), envOverride: renderEnvConfigured(), warning })
}
