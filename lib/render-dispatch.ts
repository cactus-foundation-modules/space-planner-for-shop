import { createHmac, timingSafeEqual } from 'crypto'
import { getActiveMediaProvider, getSessionSecret, getSiteUrl, isMediaProviderConfigured } from '@/lib/config/env'
import { buildLibraryUploadKey, isS3Provider, workerUrl } from '@/lib/media/upload'
import { signUploadToken, UPLOAD_TOKEN_TTL_MS } from '@/lib/media/upload-token'

// Everything the worker is told, and the one thing it is trusted with.
//
// The worker is deliberately stupid. It does not know what a room is, it has no
// three.js of its own and it never sees a price: it opens a page THIS SITE
// serves, waits for the page to say it has finished drawing, photographs it,
// puts the bytes where it is told, and says it is done.
//
// That is not laziness, it is the anti-drift measure. The alternative - a worker
// that assembles the scene itself from a description - is two implementations of
// one room, and the day they disagree is the day a customer's picture stops
// matching their plan, months after anybody could remember why. Here there is
// only ever one renderer, and it is the one the shopper already looked at.

/** How long a render page token is good for. Long enough for a cold machine to
 * pull an image and boot, short enough that a leaked url is not a back door. */
const PAGE_TOKEN_TTL_MS = 30 * 60 * 1000

const PAGE_TOKEN_LABEL = 'spl-render-page-v1'

function pageKey(): string {
  return createHmac('sha256', getSessionSecret()).update(PAGE_TOKEN_LABEL).digest('hex')
}

/**
 * A token that lets the worker's browser - which has no session and never will -
 * open one job's render page and nothing else.
 *
 * Bound to the job id and an expiry, signed with a key derived from
 * SESSION_SECRET, so there is nothing extra to configure and nothing extra
 * stored. Same shape as the media upload token, for the same reasons.
 */
export function signRenderPageToken(jobId: string, now = Date.now()): string {
  const exp = now + PAGE_TOKEN_TTL_MS
  const sig = createHmac('sha256', pageKey()).update(`${jobId}\n${exp}`).digest('base64url')
  return `${exp}.${sig}`
}

export function verifyRenderPageToken(jobId: string, token: string, now = Date.now()): boolean {
  const dot = token.indexOf('.')
  if (dot === -1) return false
  const exp = Number(token.slice(0, dot))
  if (!Number.isFinite(exp) || exp < now) return false
  const expected = createHmac('sha256', pageKey()).update(`${jobId}\n${exp}`).digest('base64url')
  const a = Buffer.from(token.slice(dot + 1))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The picture's shape. 3200 wide is rendered and kept - it is a photograph of
 * somebody's office, and they will want to zoom into it. */
export const RENDER_WIDTH = 3200
export const RENDER_HEIGHT = 1800

export type RenderJobPayload = {
  jobId: string
  pageUrl: string
  width: number
  height: number
  uploadUrl: string
  uploadToken: string
  uploadContentType: string
  callbackUrl: string
  callbackToken: string
}

export class RenderStorageError extends Error {}

/**
 * Build the job. Throws RenderStorageError, in plain English, when this site's
 * media storage cannot take a direct upload - because a 3200px picture is well
 * past what a serverless request body will carry, so there is no quiet fallback
 * to take instead.
 */
export async function buildRenderJobPayload(opts: { jobId: string; callbackToken: string }): Promise<{ payload: RenderJobPayload; key: string }> {
  const provider = await getActiveMediaProvider()
  if (!provider || !isMediaProviderConfigured(provider)) {
    throw new RenderStorageError('Media storage is not set up on this site, so there is nowhere to put the picture.')
  }
  const base = workerUrl()
  if (!base || !isS3Provider(provider)) {
    throw new RenderStorageError(
      'Pictures need the media storage that uploads straight to the store. This site is on a provider that cannot, so the picture has nowhere to land.',
    )
  }

  const key = await buildLibraryUploadKey(provider, 'image/webp', `space-plan-${opts.jobId}.webp`)
  const { token } = signUploadToken(key, UPLOAD_TOKEN_TTL_MS)
  const site = getSiteUrl()

  return {
    key,
    payload: {
      jobId: opts.jobId,
      pageUrl: `${site}/space-planner/render/${opts.jobId}?token=${encodeURIComponent(signRenderPageToken(opts.jobId))}`,
      width: RENDER_WIDTH,
      height: RENDER_HEIGHT,
      uploadUrl: `${base}/${key}`,
      uploadToken: token,
      uploadContentType: 'image/webp',
      callbackUrl: `${site}/api/m/space-planner-for-shop/public/render-callback`,
      callbackToken: opts.callbackToken,
    },
  }
}
