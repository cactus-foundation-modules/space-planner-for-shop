import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireMember } from '@/modules/space-planner-for-shop/lib/member-gate'
import {
  archivePlanVersion,
  getPlanForMember,
  getPlanVersion,
  labelPlanVersion,
  listPlanVersions,
  updatePlan,
} from '@/modules/space-planner-for-shop/lib/db/plans'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'

// Version history for one plan.
//
// GET   - the list, newest first, with item counts rather than the blobs.
// POST  - restore version N.
// PATCH - label (or unlabel) version N so the cap never sweeps it.
//
// Restoring is not a separate verb on the database: it archives the current
// state and then writes the old one back through the ordinary save path, so a
// restore is itself versioned and cannot destroy the thing it replaced. Core's
// Layout history works exactly this way, and the comment there puts it best -
// restoring a published layout IS publishing.

const RestoreSchema = z.object({ version: z.number().int().min(1) })
const LabelSchema = z.object({ version: z.number().int().min(1), label: z.string().max(120).nullable() })

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const versions = await listPlanVersions(id)
  return NextResponse.json({
    versions: versions.map((version) => ({
      version: version.version,
      label: version.label,
      itemCount: version.items.items.filter((item) => !item.staged).length,
      createdAt: version.createdAt,
    })),
  })
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const parsed = RestoreSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Which version?' }, { status: 400 })

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const version = await getPlanVersion(id, parsed.data.version)
  if (!version) return NextResponse.json({ error: 'That version is no longer kept.' }, { status: 404 })

  const config = await getSplConfigCached()
  await archivePlanVersion(plan, config.maxVersionsPerPlan)

  const restored = await updatePlan(id, gate.member.id, {
    items: version.items,
    productSnapshot: version.productSnapshot,
  })
  return NextResponse.json({ plan: restored })
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireMember()
  if (gate.error) return gate.error
  const { id } = await context.params

  const parsed = LabelSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Which version, and what label?' }, { status: 400 })

  const plan = await getPlanForMember(id, gate.member.id)
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await labelPlanVersion(id, parsed.data.version, parsed.data.label)
  return NextResponse.json({ ok: true })
}
