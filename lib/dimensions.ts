import { parseLength } from '@/modules/space-planner-for-shop/lib/units'

// Turning a supplier's spec text into a number of millimetres.
//
// The catalogue's dimension columns are free text written by people, and they
// contain everything you would expect them to: "1200mm", "1200", "120cm",
// "W1600 x D800 x H730", "1400 - 1800mm", "1200mm (per bay)", and a certain
// amount of prose. Twelve and a half thousand products carry an Overall Width,
// so this parser is the single biggest lever on whether the planner looks
// right - and it is also the single easiest place to invent a plausible lie.
//
// So the rule is: parse what is unambiguous, and refuse everything else out
// loud. A refusal lands in the junk tail on the admin's dimension report, where
// somebody can see the actual text and fix the sheet. A guess lands in a
// customer's floor plan and is never seen again.

export type DimensionNote =
  | 'exact'
  /** "1400 - 1800mm": the lower bound is the base model and the seated height. */
  | 'range-lower'
  /** "1200 / 1400 / 1600": the first figure is the one the SKU is sold as. */
  | 'first-of-list'
  /** The text named no unit, so the caller's column convention was applied. */
  | 'assumed-unit'

export type DimensionParse =
  | { ok: true; mm: number; note: DimensionNote; raw: string }
  | { ok: false; reason: string; raw: string }

/** Anything outside this is not a piece of office furniture, whatever the text says. */
export const MIN_PLAUSIBLE_MM = 5
export const MAX_PLAUSIBLE_MM = 20_000

// Leading labels the sheets carry: "Overall Width: 1600mm", "W 1600", "Depth - 800".
const LABEL_PREFIX = /^\s*(?:overall\s+)?(?:width|depth|height|length|w|d|h|l)\s*[:\-–]?\s*/i
// Trailing parentheticals: "1200mm (per bay)", "800 (approx)".
const TRAILING_NOTE = /\s*\([^)]*\)\s*$/

function clean(raw: string): string {
  return raw.replace(TRAILING_NOTE, '').replace(LABEL_PREFIX, '').trim()
}

function plausible(mm: number): boolean {
  return Number.isFinite(mm) && mm >= MIN_PLAUSIBLE_MM && mm <= MAX_PLAUSIBLE_MM
}

// The unit a piece of text names at its end, if it names one at all.
const UNIT_TAIL = /(mm|millimetres?|millimeters?|cm|centimetres?|centimeters?|m|metres?|meters?|in|ins|inch|inches|"|ft|feet|foot|')\s*$/i

function namedUnit(text: string): string | null {
  return text.trim().match(UNIT_TAIL)?.[1] ?? null
}

/**
 * Lend one half of an expression the unit written on the other half.
 *
 * People write a range or a list with the unit ONCE, at the end: "66.5-131.5cm",
 * "1200 / 1400 / 1600mm". Parsed half by half, the first figure is a bare number
 * and falls through to the caller's `assume` - which is how every height
 * adjustable desk in this catalogue came to be 67 mm tall, and how a chair whose
 * spec reads 111-127cm was drawn eleven centimetres high and then squashed onto
 * that by the scene. The unit is not being guessed here: it is written down, on
 * the same expression, about the same measurement.
 */
function withUnitFrom(text: string, donor: string): string {
  if (namedUnit(text)) return text
  const unit = namedUnit(donor)
  return unit ? `${text.trim()}${unit}` : text
}

/**
 * Parse a single spec value into millimetres.
 *
 * `assume` is the unit convention of the column the value came out of - what the
 * caller knows and the text does not. It is only ever applied to a bare number.
 */
export function parseDimensionValue(raw: string, assume: 'mm' | 'cm' | 'm' | 'in' = 'mm'): DimensionParse {
  const original = String(raw ?? '')
  const text = clean(original)
  if (!text) return { ok: false, reason: 'Empty', raw: original }

  // A range: take the lower bound. For a width that is the base model; for a
  // sit-stand height it is the seated position, which is the representative pose
  // the planner draws anyway. Taking the upper bound would draw every adjustable
  // desk at standing height, which looks like a mistake because it is one.
  const range = text.match(/^(.+?)\s*(?:-|–|to)\s*(.+)$/i)
  if (range) {
    const upperText = range[2] ?? ''
    const lower = parseOne(withUnitFrom(range[1] ?? '', upperText), assume)
    // Only trust it as a range when both halves parse; "1200-off" is not a range.
    const upper = parseOne(upperText, assume)
    if (lower !== null && upper !== null && plausible(lower)) {
      return { ok: true, mm: Math.round(lower), note: 'range-lower', raw: original }
    }
  }

  // A list: "1200 / 1400 / 1600". The first is what this SKU is.
  if (text.includes('/')) {
    const parts = text.split('/')
    const first = parseOne(withUnitFrom(parts[0] ?? '', parts[parts.length - 1] ?? ''), assume)
    if (first !== null && plausible(first)) {
      return { ok: true, mm: Math.round(first), note: 'first-of-list', raw: original }
    }
  }

  const single = parseOne(text, assume)
  if (single === null) return { ok: false, reason: 'Not a length', raw: original }
  if (!plausible(single)) {
    return { ok: false, reason: `${Math.round(single)} mm is not a plausible furniture dimension`, raw: original }
  }

  const named = /(mm|cm|m|in|ft|"|'|metre|meter|inch|foot|feet)\b|["']/i.test(text)
  return { ok: true, mm: Math.round(single), note: named ? 'exact' : 'assumed-unit', raw: original }
}

function parseOne(text: string, assume: 'mm' | 'cm' | 'm' | 'in'): number | null {
  const parsed = parseLength(text.trim(), assume)
  return parsed ? parsed.mm : null
}

export type DimensionTriple = {
  widthMm: number | null
  depthMm: number | null
  heightMm: number | null
}

// "W1600 x D800 x H730mm", "1600 × 800 × 730", "1600x800".
const TRIPLE_SPLIT = /\s*(?:x|×|\*)\s*/i

/**
 * Parse a combined "W x D x H" string, which is how a fair number of suppliers
 * write a single Dimensions column.
 *
 * Where the parts are labelled, the labels win - suppliers are not consistent
 * about order, and "H2000 x W800 x D400" for a cupboard is common. Where they
 * are not, the conventional width/depth/height order is assumed, and a
 * two-figure value is width and depth with no height at all rather than a
 * height invented to fill the gap.
 */
export function parseDimensionTriple(raw: string, assume: 'mm' | 'cm' | 'm' | 'in' = 'mm'): DimensionTriple | null {
  const text = String(raw ?? '').replace(TRAILING_NOTE, '').trim()
  if (!text) return null
  const parts = text.split(TRIPLE_SPLIT).map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return null

  const result: DimensionTriple = { widthMm: null, depthMm: null, heightMm: null }
  const unlabelled: number[] = []

  // A trailing unit applies to the whole expression: "1600 x 800 x 730 mm".
  const trailingUnit = text.match(/(mm|cm|m|in|ft)\s*$/i)?.[1]?.toLowerCase()

  for (const part of parts) {
    const label = part.match(/^([wdhl])\s*/i)?.[1]?.toLowerCase()
    const withUnit = /(mm|cm|m|in|ft|"|')\s*$/i.test(part) || !trailingUnit ? part : `${part}${trailingUnit}`
    const parsed = parseDimensionValue(withUnit, assume)
    if (!parsed.ok) continue
    if (label === 'w' || label === 'l') result.widthMm = parsed.mm
    else if (label === 'd') result.depthMm = parsed.mm
    else if (label === 'h') result.heightMm = parsed.mm
    else unlabelled.push(parsed.mm)
  }

  if (unlabelled.length) {
    if (result.widthMm === null) result.widthMm = unlabelled.shift() ?? null
    if (result.depthMm === null) result.depthMm = unlabelled.shift() ?? null
    if (result.heightMm === null) result.heightMm = unlabelled.shift() ?? null
  }

  if (result.widthMm === null && result.depthMm === null && result.heightMm === null) return null
  return result
}

/**
 * The spec attribute names the ladder looks for, in the order it prefers them.
 * Matching is case-insensitive and exact on the trimmed name, because a
 * substring match on "Width" also catches "Width Under Top", which is a
 * completely different measurement and would put a pedestal-sized desk in
 * somebody's office.
 */
export const WIDTH_ATTRIBUTES = ['overall width', 'width', 'overall length']
export const DEPTH_ATTRIBUTES = ['overall depth', 'depth', 'overall projection']
export const HEIGHT_ATTRIBUTES = ['overall height (spec)', 'overall height', 'height']
export const UNDER_TOP_HEIGHT_ATTRIBUTES = ['height under top', 'clearance under top']
export const UNDER_TOP_WIDTH_ATTRIBUTES = ['width under top', 'clearance width under top']
export const COMBINED_ATTRIBUTES = ['dimensions', 'overall dimensions', 'size']

export function matchesAttribute(name: string, candidates: string[]): boolean {
  const normalised = name.trim().toLowerCase()
  return candidates.includes(normalised)
}

/**
 * Two independent sources of truth that disagree mean one of them is wrong, and
 * quietly preferring either is how a beautifully rendered room ends up full of
 * furniture that is not the size it claims. Ten per cent is loose enough to
 * absorb a castor or a cable tray and tight enough to catch a scale error.
 */
export const CONFLICT_TOLERANCE = 0.1

export function dimensionsConflict(
  a: { widthMm: number | null; depthMm: number | null; heightMm: number | null },
  b: { widthMm: number | null; depthMm: number | null; heightMm: number | null },
): string {
  const axes: Array<[string, number | null, number | null]> = [
    ['width', a.widthMm, b.widthMm],
    ['depth', a.depthMm, b.depthMm],
    ['height', a.heightMm, b.heightMm],
  ]
  const offenders: string[] = []
  for (const [axis, left, right] of axes) {
    if (left === null || right === null || left <= 0 || right <= 0) continue
    const drift = Math.abs(left - right) / Math.max(left, right)
    if (drift > CONFLICT_TOLERANCE) {
      offenders.push(`${axis}: model says ${Math.round(left)} mm, spec says ${Math.round(right)} mm`)
    }
  }
  return offenders.join('; ')
}
