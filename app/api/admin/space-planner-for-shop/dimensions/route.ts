import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSplUser } from '@/modules/space-planner-for-shop/lib/access'
import {
  deleteCategoryDefault,
  getDimensionReport,
  listCategoriesWithoutDefaults,
  listCategoryDefaults,
  listConflicts,
  listJunkTail,
  upsertCategoryDefault,
} from '@/modules/space-planner-for-shop/lib/db/dimension-cache'
import { MOUNT_TYPES } from '@/modules/space-planner-for-shop/lib/types'
import { getActiveBackfill, getLatestBackfill } from '@/modules/space-planner-for-shop/lib/db/jobs'

// The dimension report: how the catalogue is being sized, what the parser choked
// on, where a model and a spec sheet disagree, and which categories have no
// fallback yet.
//
// The junk tail carries the actual text rather than a count, because "1,412
// values failed to parse" is a number nobody can act on and "Overall Width:
// please enquire" is a sheet somebody can fix in a minute.

export async function GET() {
  const gate = await requireSplUser('space-planner.access', { allowAccess: true })
  if (gate.error) return gate.error

  const [report, junk, conflicts, defaults, missingDefaults, active, latest] = await Promise.all([
    getDimensionReport(),
    listJunkTail(),
    listConflicts(),
    listCategoryDefaults(),
    listCategoriesWithoutDefaults(),
    getActiveBackfill(),
    getLatestBackfill(),
  ])

  return NextResponse.json({ report, junk, conflicts, defaults, missingDefaults, job: active ?? latest })
}

const DefaultSchema = z.object({
  categoryId: z.string().min(1).max(64),
  widthMm: z.number().int().min(1).max(20_000).nullable(),
  depthMm: z.number().int().min(1).max(20_000).nullable(),
  heightMm: z.number().int().min(1).max(20_000).nullable(),
  mountType: z.enum(MOUNT_TYPES as [string, ...string[]]),
})

export async function PUT(request: NextRequest) {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error

  const parsed = DefaultSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error?.issues[0]?.message ?? 'Invalid default' }, { status: 400 })
  }

  await upsertCategoryDefault({
    categoryId: parsed.data.categoryId,
    widthMm: parsed.data.widthMm,
    depthMm: parsed.data.depthMm,
    heightMm: parsed.data.heightMm,
    mountType: parsed.data.mountType as (typeof MOUNT_TYPES)[number],
  })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error

  const categoryId = request.nextUrl.searchParams.get('categoryId')
  if (!categoryId) return NextResponse.json({ error: 'Which category?' }, { status: 400 })

  await deleteCategoryDefault(categoryId)
  return NextResponse.json({ ok: true })
}
