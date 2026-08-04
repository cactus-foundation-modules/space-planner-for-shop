import { describe, expect, it } from 'vitest'
import { modelScaleFor } from '@/modules/space-planner-for-shop/lib/three/model-scale'

// The chair in the screenshot that started this: a Galaxy operator chair, drawn
// squashed flat and stretched wide in a customer-facing planner.

describe('modelScaleFor', () => {
  it('leaves a model alone when the plan and the mesh agree', () => {
    const scale = modelScaleFor({ widthMm: 675, depthMm: 640, heightMm: 1110 }, { width: 0.675, depth: 0.64, height: 1.11 }, false)
    expect(scale.x).toBeCloseTo(1)
    expect(scale.y).toBeCloseTo(1)
    expect(scale.z).toBeCloseTo(1)
  })

  it('refuses to flatten a model onto an impossible height', () => {
    // "Overall Height (spec): 111-127cm" read as 111 mm. The height axis is not
    // evidence about anything; the other two are.
    const scale = modelScaleFor({ widthMm: 675, depthMm: 640, heightMm: 1150 }, { width: 0.675, depth: 0.64, height: 0.111 }, false)
    expect(scale.y).toBeCloseTo(1)
    expect(scale.y).toBe(scale.x)
  })

  it('keeps a model in proportion when the size is only approximate', () => {
    // The generic 800 x 600 x 750 block. Nobody measured this product, so the
    // mesh's own proportions are the better information.
    const scale = modelScaleFor({ widthMm: 675, depthMm: 640, heightMm: 1150 }, { width: 0.8, depth: 0.6, height: 0.75 }, true)
    expect(scale.uniform).toBe(true)
    expect(scale.x).toBe(scale.y)
    expect(scale.y).toBe(scale.z)
  })

  it('still stretches a desk model to a width the range actually comes in', () => {
    // One 1400 mm model serving the 1600 mm SKU. Suppliers widen a desk by
    // sliding its ends apart, so this is a real size, not a distortion.
    const scale = modelScaleFor({ widthMm: 1400, depthMm: 800, heightMm: 730 }, { width: 1.6, depth: 0.8, height: 0.73 }, false)
    expect(scale.uniform).toBe(false)
    expect(scale.x).toBeCloseTo(1600 / 1400)
    expect(scale.y).toBeCloseTo(1)
    expect(scale.z).toBeCloseTo(1)
  })

  it('goes uniform rather than deforming when the axes disagree badly', () => {
    const scale = modelScaleFor({ widthMm: 600, depthMm: 600, heightMm: 1200 }, { width: 1.2, depth: 0.6, height: 0.7 }, false)
    expect(scale.uniform).toBe(true)
    expect(scale.x).toBe(scale.z)
  })

  it('draws the file at its own size when nothing is usable', () => {
    const scale = modelScaleFor({ widthMm: 0, depthMm: 0, heightMm: 0 }, { width: 1.2, depth: 0.8, height: 0.73 }, false)
    expect(scale).toMatchObject({ x: 1, y: 1, z: 1, uniform: true })
  })

  it('ignores an axis the plan has no figure for', () => {
    const scale = modelScaleFor({ widthMm: 1400, depthMm: 800, heightMm: 730 }, { width: 1.4, depth: 0, height: 0.73 }, false)
    expect(scale.z).toBeCloseTo(1)
  })
})
