// Fitting a measured mesh to the size the plan believes in.
//
// The plan and the model are two independent statements about how big a thing
// is, and the scene has to reconcile them on every placement. This used to be
// three divisions - width over width, height over height, depth over depth,
// applied straight to the object's scale - and that is a perfectly good answer
// right up until one of the six numbers is wrong. Then it is the worst possible
// answer, because a single bad axis does not draw a small chair. It draws a
// squashed one, which reads as a broken tool rather than as bad data.
//
// So the reconciliation has rules:
//
//   1. An axis whose ratio is not physically sensible is not evidence. A spec
//      that says a desk is 67 mm tall does not get to flatten the model; that
//      axis is dropped and the surviving ones speak for it.
//   2. An APPROXIMATE size never deforms a real mesh. When the size came off a
//      category default or the generic fallback, nobody has measured this
//      product - so the model's own proportions are the better information and
//      the fit is uniform.
//   3. Beyond a modest amount, disagreement between axes means the two sources
//      are describing different things, and the honest response is to keep the
//      model's shape rather than to average the confusion into it.
//
// Below those thresholds per-axis scaling stays, because it is genuinely right:
// this catalogue's suppliers widen a desk by sliding its ends apart, and one
// model legitimately serves several widths.
//
// ALL OF THAT IS THE FALLBACK. Where the shop has told the 3D views module how
// big this product really is - its overall height, or its overall width, per
// variation - that one number settles the whole question and none of the rules
// above run. See realSizeScale below.

/** Outside this, an axis ratio is a data fault rather than a size difference. */
export const MIN_TRUSTED_RATIO = 0.4
export const MAX_TRUSTED_RATIO = 2.5

/**
 * How far the axis ratios may disagree with each other before a stretch is
 * treated as a distortion. A desk model serving a wider desk sits comfortably
 * under this; a chair pushed into a generic 800 x 600 x 750 block does not.
 */
export const MAX_AXIS_SPREAD = 1.5

export type Measured = { widthMm: number; depthMm: number; heightMm: number }
/** The plan's size for this item, in metres - as SceneNode carries it. */
export type Planned = { width: number; depth: number; height: number }

export type ModelScale = {
  x: number
  y: number
  z: number
  /** True when the mesh kept its own proportions rather than taking the plan's. */
  uniform: boolean
}

/**
 * What the shop has said this product really measures, along the one axis the 3D
 * views module's material setup pins its scale by - `realCm` along `scaleAxis`,
 * converted to metres here because the scene works in metres.
 *
 * This is a per-variation figure typed (or ticked) by the owner against the file
 * that draws it, and it already decides how big a weave tiles on that model and
 * how big the thing arrives in AR. It is a better statement about the product
 * than the spec sheet is, because it was written to describe the MODEL.
 */
export type RealSize = { metres: number; axis: 'height' | 'width' }

// Sanity bounds on that figure, in metres. Same intent as the plausibility bounds
// in lib/dimensions, restated here rather than imported because this file is a
// browser leaf and dimensions.ts is the parser the server side uses. A "size" of
// forty metres is a units mistake, and acting on it would put a building in the
// room.
const MIN_REAL_M = 0.02
const MAX_REAL_M = 20

/**
 * The uniform scale that makes the mesh the size the shop says it is.
 *
 * One real dimension against the same dimension measured off the mesh is the
 * whole sum - every other axis follows, because a model drawn at its own
 * proportions is the only version of it that is not a lie about the product's
 * shape. Null when there is no usable figure, which sends the caller back to
 * reconciling with the plan.
 */
export function realSizeScale(measured: Measured, real: RealSize | null): number | null {
  if (!real) return null
  if (!(real.metres >= MIN_REAL_M) || real.metres > MAX_REAL_M) return null
  const extentMm = real.axis === 'width' ? measured.widthMm : measured.heightMm
  if (!(extentMm > 0)) return null
  const factor = (real.metres * 1000) / extentMm
  return Number.isFinite(factor) && factor > 0 ? factor : null
}

function median(values: number[]): number {
  if (values.length === 0) return 1
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

/**
 * The scale to put on the holder around a prepared model.
 *
 * `measured` is millimetres off the mesh; `planned` is metres, because that is
 * the unit the scene description works in and converting at one end only is how
 * this stays readable.
 */
export function modelScaleFor(measured: Measured, planned: Planned, approximate: boolean, real: RealSize | null = null): ModelScale {
  // The recorded real size outranks the whole reconciliation below it. Nothing
  // here is a judgement call once the owner has stated the product's overall
  // height (or width) against the file that draws it: scale to that, uniformly,
  // and leave the model's proportions exactly as its maker left them.
  const fromReal = realSizeScale(measured, real)
  if (fromReal !== null) return { x: fromReal, y: fromReal, z: fromReal, uniform: true }

  const axes: Array<['x' | 'y' | 'z', number, number]> = [
    ['x', planned.width * 1000, measured.widthMm],
    ['y', planned.height * 1000, measured.heightMm],
    ['z', planned.depth * 1000, measured.depthMm],
  ]

  const ratios = new Map<'x' | 'y' | 'z', number>()
  for (const [axis, want, have] of axes) {
    if (!(want > 0) || !(have > 0)) continue
    const ratio = want / have
    if (ratio < MIN_TRUSTED_RATIO || ratio > MAX_TRUSTED_RATIO) continue
    ratios.set(axis, ratio)
  }

  const trusted = [...ratios.values()]
  // Nothing usable: draw the file at the size it was exported. A model at its own
  // size next to a room at the right size is a visible, explicable difference; a
  // model crushed to a tenth of its height is neither.
  if (trusted.length === 0) return { x: 1, y: 1, z: 1, uniform: true }

  const base = median(trusted)
  const spread = Math.max(...trusted) / Math.min(...trusted)

  if (approximate || spread > MAX_AXIS_SPREAD) {
    return { x: base, y: base, z: base, uniform: true }
  }

  return {
    x: ratios.get('x') ?? base,
    y: ratios.get('y') ?? base,
    z: ratios.get('z') ?? base,
    uniform: false,
  }
}
