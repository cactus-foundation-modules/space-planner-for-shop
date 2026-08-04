// Length parsing and formatting.
//
// Everything this module stores is an integer number of millimetres. That is not
// a style choice: a room is saved, reopened months later, edited, and saved
// again, and a float that has been through three of those round trips prints as
// 2399.9999999999995 on somebody's floor plan. Millimetres are also the unit the
// catalogue's own spec attributes are mostly written in, so the conversions all
// happen at the edges and never in the middle.
//
// Input is a different matter. People type "2.4m", "240cm", "8ft", "7' 10\"" and
// "2400", and a planner that only accepts one of those is a planner they give up
// on. So parsing is deliberately generous and formatting is deliberately strict.

export type Units = 'metric' | 'imperial'

const MM_PER_INCH = 25.4
const MM_PER_FOOT = 304.8

export type ParsedLength = {
  mm: number
  /** The unit the text actually named, or null when it was a bare number. */
  namedUnit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | null
}

// Feet-and-inches in any of the shapes people actually write:
//   7' 10"   7ft 10in   7 ft 10 in   7'10   7'
const FEET_INCHES = /^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|ins|inch|inches)?)?$/i
const SINGLE = /^(-?\d+(?:\.\d+)?)\s*(mm|millimetres?|millimeters?|cm|centimetres?|centimeters?|m|metres?|meters?|in|ins|inch|inches|"|ft|feet|foot|')?$/i

function unitToMm(raw: string | undefined, value: number): { mm: number; namedUnit: ParsedLength['namedUnit'] } | null {
  const unit = (raw ?? '').toLowerCase()
  if (!unit) return { mm: value, namedUnit: null }
  if (unit.startsWith('mm') || unit.startsWith('milli')) return { mm: value, namedUnit: 'mm' }
  if (unit.startsWith('cm') || unit.startsWith('centi')) return { mm: value * 10, namedUnit: 'cm' }
  if (unit === 'm' || unit.startsWith('met')) return { mm: value * 1000, namedUnit: 'm' }
  if (unit === '"' || unit.startsWith('in')) return { mm: value * MM_PER_INCH, namedUnit: 'in' }
  if (unit === "'" || unit.startsWith('ft') || unit.startsWith('f')) return { mm: value * MM_PER_FOOT, namedUnit: 'ft' }
  return null
}

/**
 * Parse one length out of free text into millimetres.
 *
 * A bare number is interpreted through `assume`, which is what the caller knows
 * and the text does not: a wall-length box on a metric room means millimetres, a
 * supplier spec column headed "Width (cm)" means centimetres.
 *
 * Returns null rather than guessing when the text is not a length. Nothing in
 * this module is allowed to invent a dimension - an unparseable value goes to
 * the junk tail in the admin where a human can see it.
 */
export function parseLength(text: string, assume: 'mm' | 'cm' | 'm' | 'in' = 'mm'): ParsedLength | null {
  const trimmed = text.trim().replace(/,/g, '')
  if (!trimmed) return null

  const fi = trimmed.match(FEET_INCHES)
  if (fi) {
    const feet = Number(fi[1])
    const inches = fi[2] ? Number(fi[2]) : 0
    if (!Number.isFinite(feet) || !Number.isFinite(inches)) return null
    return { mm: feet * MM_PER_FOOT + inches * MM_PER_INCH, namedUnit: 'ft' }
  }

  const single = trimmed.match(SINGLE)
  if (!single) return null
  const value = Number(single[1])
  if (!Number.isFinite(value)) return null

  const converted = unitToMm(single[2], value)
  if (!converted) return null
  if (converted.namedUnit === null) {
    const assumed = unitToMm(assume, value)
    return assumed ? { mm: assumed.mm, namedUnit: null } : null
  }
  return converted
}

/** Parse to a whole millimetre, or null. The form of the function every caller wants. */
export function parseLengthMm(text: string, assume: 'mm' | 'cm' | 'm' | 'in' = 'mm'): number | null {
  const parsed = parseLength(text, assume)
  if (!parsed) return null
  return Math.round(parsed.mm)
}

/** Metric display: millimetres under a metre, metres to two decimals above. */
export function formatMetric(mm: number): string {
  if (Math.abs(mm) < 1000) return `${Math.round(mm)} mm`
  const metres = mm / 1000
  return `${metres.toFixed(2).replace(/\.?0+$/, '')} m`
}

/** Imperial display, to the nearest inch - nobody plans an office to the sixteenth. */
export function formatImperial(mm: number): string {
  const totalInches = Math.round(mm / MM_PER_INCH)
  const feet = Math.trunc(totalInches / 12)
  const inches = Math.abs(totalInches % 12)
  if (feet === 0) return `${totalInches}"`
  return inches === 0 ? `${feet}'` : `${feet}' ${inches}"`
}

export function formatLength(mm: number, units: Units): string {
  return units === 'imperial' ? formatImperial(mm) : formatMetric(mm)
}

/** "1200 × 800 × 730 mm" - the caption under a placed item. */
export function formatSize(widthMm: number, depthMm: number, heightMm: number, units: Units): string {
  if (units === 'imperial') {
    return `${formatImperial(widthMm)} × ${formatImperial(depthMm)} × ${formatImperial(heightMm)}`
  }
  return `${Math.round(widthMm)} × ${Math.round(depthMm)} × ${Math.round(heightMm)} mm`
}
