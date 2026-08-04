import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSplUser } from '@/modules/space-planner-for-shop/lib/access'
import { listUnreviewedModels, upsertFileMeta, upsertProductMeta } from '@/modules/space-planner-for-shop/lib/db/model-meta'
import { MOUNT_TYPES } from '@/modules/space-planner-for-shop/lib/types'

// Model metadata curation: which way a file faces, what its footprint really is,
// whether it survives decimation, and how a product mounts.
//
// The list is a WORST-OFFENDERS view rather than an alphabetical index - models
// nobody has looked at, most-placed first. Upkeep is worth ten minutes when it
// is pointed at the twelve models customers actually use, and worth nothing at
// all as a list of two hundred and fifty in name order.

export async function GET() {
  const gate = await requireSplUser('space-planner.access', { allowAccess: true })
  if (gate.error) return gate.error
  return NextResponse.json({ models: await listUnreviewedModels() })
}

const FileSchema = z.object({
  scope: z.literal('file'),
  modelId: z.string().min(1).max(64),
  yawOffsetDegrees: z.number().int().min(-360).max(360).optional(),
  footprintOverride: z.object({ widthMm: z.number().int().min(1).max(20_000), depthMm: z.number().int().min(1).max(20_000) }).nullable().optional(),
  noDecimation: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
  reviewed: z.boolean().optional(),
})

const ProductSchema = z.object({
  scope: z.literal('product'),
  productId: z.string().min(1).max(64),
  mountType: z.enum(MOUNT_TYPES as [string, ...string[]]).nullable().optional(),
  notes: z.string().max(2000).optional(),
  reviewed: z.boolean().optional(),
})

export async function PUT(request: NextRequest) {
  const gate = await requireSplUser('space-planner.manage')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  const file = FileSchema.safeParse(body)
  if (file.success) {
    await upsertFileMeta(file.data.modelId, {
      yawOffsetDegrees: file.data.yawOffsetDegrees,
      footprintOverride: file.data.footprintOverride,
      noDecimation: file.data.noDecimation,
      notes: file.data.notes,
      reviewed: file.data.reviewed,
    })
    return NextResponse.json({ ok: true })
  }

  const product = ProductSchema.safeParse(body)
  if (product.success) {
    await upsertProductMeta(product.data.productId, {
      mountType: (product.data.mountType ?? null) as (typeof MOUNT_TYPES)[number] | null,
      notes: product.data.notes,
      reviewed: product.data.reviewed,
    })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'That did not look like either a file or a product correction.' }, { status: 400 })
}
