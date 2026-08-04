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
export function modelScaleFor(measured: Measured, planned: Planned, approximate: boolean): ModelScale {
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
