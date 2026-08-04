import { prisma } from '@/lib/db/prisma'
import type { MediaReferenceChange } from '@/lib/media/reference-rewriters'

// Provider for the core.media-reference-rewriters extension point.
//
// The module stores Media ids for thumbnails, which survive a rename on their
// own - an id does not change when a blob moves. The one column that holds a url
// verbatim is spl_render_jobs.result_url, written when a finished render comes
// back from the worker, and that one rots exactly the way an image swatch does:
// core optimises or replaces the blob, the url changes, and the plan's picture
// 404s while the library looks perfectly healthy.
//
// Equality, not substring: the column IS the whole url, so `= oldUrl` cannot
// match anything it should not.
export async function spacePlannerMediaReferenceRewriter(change: MediaReferenceChange): Promise<void> {
  const { oldUrl, newUrl } = change
  if (!oldUrl || oldUrl === newUrl) return

  await prisma.$executeRaw`
    UPDATE "spl_render_jobs" SET "result_url" = ${newUrl} WHERE "result_url" = ${oldUrl}
  `
}
