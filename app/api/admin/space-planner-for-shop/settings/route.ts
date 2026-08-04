import { NextRequest, NextResponse } from 'next/server'
import { requireSplUser } from '@/modules/space-planner-for-shop/lib/access'
import { SplConfigSchema, getSplConfig, renderWorkerConfigured, updateSplConfig } from '@/modules/space-planner-for-shop/lib/config'
import { deliveryEstimatesAvailable } from '@/modules/space-planner-for-shop/lib/delivery'

// The module's settings, read and written by the panel hosted inside Shop
// settings (manifest settingsTabs > host: shop.settings-sub-tabs).

export async function GET() {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error
  return NextResponse.json({
    config: await getSplConfig(),
    // Two read-outs the owner cannot work out from the switches: whether the
    // picture service is actually wired up, and whether this shop can answer
    // "when will it arrive" at all.
    renderWorkerConfigured: renderWorkerConfigured(),
    deliveryEstimatesAvailable: deliveryEstimatesAvailable(),
  })
}

export async function PUT(request: NextRequest) {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error

  const parsed = SplConfigSchema.partial().safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error?.issues[0]?.message ?? 'Invalid settings' }, { status: 400 })
  }

  const config = await updateSplConfig(parsed.data)
  return NextResponse.json({ config })
}
