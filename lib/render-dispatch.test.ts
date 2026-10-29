import { describe, expect, it } from 'vitest'
import { imageTakesPresignedUploads } from '@/modules/space-planner-for-shop/lib/render-dispatch'

describe('imageTakesPresignedUploads', () => {
  it('refuses the v1 image, which always sends the upload token as a bearer', () => {
    expect(imageTakesPresignedUploads('ghcr.io/cactus-foundation-modules/space-planner-render-worker:v1')).toBe(false)
    expect(imageTakesPresignedUploads(' ghcr.io/cactus-foundation-modules/space-planner-render-worker:v1 ')).toBe(false)
  })

  it('takes any later tag, a digest or an image the owner built at its word', () => {
    expect(imageTakesPresignedUploads('ghcr.io/cactus-foundation-modules/space-planner-render-worker:v2')).toBe(true)
    expect(imageTakesPresignedUploads('ghcr.io/cactus-foundation-modules/space-planner-render-worker:v10')).toBe(true)
    expect(imageTakesPresignedUploads('ghcr.io/cactus-foundation-modules/space-planner-render-worker@sha256:abc')).toBe(true)
    expect(imageTakesPresignedUploads('registry.example.com/my-render-worker:v1')).toBe(true)
  })
})
