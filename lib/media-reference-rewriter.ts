import { prisma } from '@/lib/db/prisma'
import type { MediaReferenceChange } from '@/lib/media/reference-rewriters'

// Provider for the core.media-reference-rewriters extension point.
//
// The module stores Media ids for thumbnails, which survive a rename on their
// own - an id does not change when a blob moves. Two things hold a url verbatim
// and both rot the way an image swatch does when core optimises or replaces a
// blob: spl_render_jobs.result_url, and the product_snapshot blob on every plan
// and every archived version of one, which keeps the catalogue thumbnail each
// line was showing when the plan was saved.
//
// Equality, not substring: each value IS the whole url, so `= oldUrl` cannot
// match anything it should not.
export async function spacePlannerMediaReferenceRewriter(change: MediaReferenceChange): Promise<void> {
  const { oldUrl, newUrl } = change
  if (!oldUrl || oldUrl === newUrl) return

  await prisma.$executeRaw`
    UPDATE "spl_render_jobs" SET "result_url" = ${newUrl} WHERE "result_url" = ${oldUrl}
  `

  // The snapshot is an object keyed by product id, each entry carrying an
  // `image`. jsonb_object_agg rebuilds it with the one key replaced, which is
  // the only way to touch a value inside it without reading the whole thing out
  // and writing it back. Guarded on the plan actually holding the url, so a
  // rename does not rewrite every row in the table.
  await prisma.$executeRaw`
    UPDATE "spl_plans" SET "product_snapshot" = (
      SELECT jsonb_object_agg(
        entry.key,
        CASE WHEN entry.value ->> 'image' = ${oldUrl} THEN jsonb_set(entry.value, '{image}', to_jsonb(${newUrl}::text)) ELSE entry.value END
      )
      FROM jsonb_each("product_snapshot") AS entry
    )
    WHERE jsonb_typeof("product_snapshot") = 'object'
      AND EXISTS (SELECT 1 FROM jsonb_each("product_snapshot") AS entry WHERE entry.value ->> 'image' = ${oldUrl})
  `

  await prisma.$executeRaw`
    UPDATE "spl_plan_versions" SET "product_snapshot" = (
      SELECT jsonb_object_agg(
        entry.key,
        CASE WHEN entry.value ->> 'image' = ${oldUrl} THEN jsonb_set(entry.value, '{image}', to_jsonb(${newUrl}::text)) ELSE entry.value END
      )
      FROM jsonb_each("product_snapshot") AS entry
    )
    WHERE jsonb_typeof("product_snapshot") = 'object'
      AND EXISTS (SELECT 1 FROM jsonb_each("product_snapshot") AS entry WHERE entry.value ->> 'image' = ${oldUrl})
  `
}
