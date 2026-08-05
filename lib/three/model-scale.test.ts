import { describe, expect, it } from 'vitest'
import { modelScaleFor, realSizeScale } from '@/modules/space-planner-for-shop/lib/three/model-scale'

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

  it('scales uniformly to the recorded real height and ignores the plan entirely', () => {
    // The chair whose spec sheet says 111 cm and whose mesh is 115 cm. The plan's
    // width and depth are not consulted at all: one real dimension is the answer.
    const scale = modelScaleFor(
      { widthMm: 675, depthMm: 640, heightMm: 1150 },
      { width: 0.8, depth: 0.6, height: 0.75 },
      false,
      { metres: 1.11, axis: 'height' },
    )
    expect(scale.uniform).toBe(true)
    expect(scale.y).toBeCloseTo(1110 / 1150)
    expect(scale.x).toBe(scale.y)
    expect(scale.z).toBe(scale.y)
  })

  it('measures along the width when that is the axis the shop scales by', () => {
    const scale = modelScaleFor(
      { widthMm: 1400, depthMm: 800, heightMm: 730 },
      { width: 1.6, depth: 0.8, height: 0.73 },
      false,
      { metres: 1.4, axis: 'width' },
    )
    expect(scale.uniform).toBe(true)
    expect(scale.x).toBeCloseTo(1)
  })

  it('overrides an approximate size rather than deferring to it', () => {
    const scale = modelScaleFor(
      { widthMm: 675, depthMm: 640, heightMm: 1150 },
      { width: 0.8, depth: 0.6, height: 0.75 },
      true,
      { metres: 1.11, axis: 'height' },
    )
    expect(scale.y).toBeCloseTo(1110 / 1150)
  })

  it('falls back to the plan when the recorded size is a units mistake', () => {
    // "1110" read as metres. Forty metres of chair is worse than no chair.
    const scale = modelScaleFor(
      { widthMm: 675, depthMm: 640, heightMm: 1110 },
      { width: 0.675, depth: 0.64, height: 1.11 },
      false,
      { metres: 1110, axis: 'height' },
    )
    expect(scale.y).toBeCloseTo(1)
  })

  it('falls back to the plan when the mesh has no extent along that axis', () => {
    const scale = modelScaleFor(
      { widthMm: 0, depthMm: 640, heightMm: 1110 },
      { width: 0.675, depth: 0.64, height: 1.11 },
      false,
      { metres: 1.4, axis: 'width' },
    )
    expect(scale.y).toBeCloseTo(1)
  })
})

describe('realSizeScale', () => {
  const MESH = { widthMm: 1400, depthMm: 800, heightMm: 730 }

  it('is null with nothing recorded', () => {
    expect(realSizeScale(MESH, null)).toBeNull()
  })

  it('is null for a size no piece of furniture has', () => {
    expect(realSizeScale(MESH, { metres: 0.001, axis: 'height' })).toBeNull()
    expect(realSizeScale(MESH, { metres: 40, axis: 'height' })).toBeNull()
  })

  it('is the ratio of the real size to the measured one', () => {
    expect(realSizeScale(MESH, { metres: 1.6, axis: 'width' })).toBeCloseTo(1600 / 1400)
    expect(realSizeScale(MESH, { metres: 0.73, axis: 'height' })).toBeCloseTo(1)
  })
})
