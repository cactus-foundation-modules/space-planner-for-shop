import { describe, expect, it } from 'vitest'
import {
  dimensionsConflict,
  matchesAttribute,
  parseDimensionTriple,
  parseDimensionValue,
  WIDTH_ATTRIBUTES,
} from '@/modules/space-planner-for-shop/lib/dimensions'

describe('parseDimensionValue', () => {
  it('reads the ordinary cases', () => {
    expect(parseDimensionValue('1200mm')).toMatchObject({ ok: true, mm: 1200, note: 'exact' })
    expect(parseDimensionValue('120cm')).toMatchObject({ ok: true, mm: 1200, note: 'exact' })
    expect(parseDimensionValue('1.2m')).toMatchObject({ ok: true, mm: 1200, note: 'exact' })
  })

  it('strips the label the sheet put in front of the number', () => {
    expect(parseDimensionValue('Overall Width: 1600mm')).toMatchObject({ ok: true, mm: 1600 })
    expect(parseDimensionValue('W 1600')).toMatchObject({ ok: true, mm: 1600 })
    expect(parseDimensionValue('Depth - 800mm')).toMatchObject({ ok: true, mm: 800 })
  })

  it('drops a trailing parenthetical rather than choking on it', () => {
    expect(parseDimensionValue('1200mm (per bay)')).toMatchObject({ ok: true, mm: 1200 })
  })

  it('takes the lower bound of a range', () => {
    // A sit-stand desk drawn at standing height in every plan looks like a bug,
    // because it is one.
    expect(parseDimensionValue('650 - 1300mm')).toMatchObject({ ok: true, mm: 650, note: 'range-lower' })
    expect(parseDimensionValue('1400 to 1800mm')).toMatchObject({ ok: true, mm: 1400, note: 'range-lower' })
  })

  it('takes the first of a list', () => {
    expect(parseDimensionValue('1200 / 1400 / 1600mm')).toMatchObject({ ok: true, mm: 1200, note: 'first-of-list' })
  })

  it('marks a bare number as having used the column convention', () => {
    expect(parseDimensionValue('1200')).toMatchObject({ ok: true, mm: 1200, note: 'assumed-unit' })
    expect(parseDimensionValue('120', 'cm')).toMatchObject({ ok: true, mm: 1200, note: 'assumed-unit' })
  })

  it('refuses prose instead of inventing a size', () => {
    expect(parseDimensionValue('made to order')).toMatchObject({ ok: false })
    expect(parseDimensionValue('please enquire')).toMatchObject({ ok: false })
    expect(parseDimensionValue('')).toMatchObject({ ok: false })
  })

  it('refuses an implausible figure even though it parses', () => {
    // Somebody typed metres in a millimetre column. That is a data defect, and
    // it belongs in the junk tail rather than in a 40-metre desk.
    const result = parseDimensionValue('120000mm')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('plausible')
  })
})

describe('parseDimensionTriple', () => {
  it('reads an unlabelled w x d x h', () => {
    expect(parseDimensionTriple('1600 x 800 x 730mm')).toEqual({ widthMm: 1600, depthMm: 800, heightMm: 730 })
  })

  it('believes the labels over the order', () => {
    expect(parseDimensionTriple('H2000 x W800 x D400mm')).toEqual({ widthMm: 800, depthMm: 400, heightMm: 2000 })
  })

  it('leaves a missing axis null rather than filling it in', () => {
    expect(parseDimensionTriple('1600 x 800mm')).toEqual({ widthMm: 1600, depthMm: 800, heightMm: null })
  })

  it('returns null when there is nothing to read', () => {
    expect(parseDimensionTriple('various')).toBeNull()
    expect(parseDimensionTriple('')).toBeNull()
  })
})

describe('attribute matching', () => {
  it('matches exactly so "Width Under Top" is never mistaken for a width', () => {
    expect(matchesAttribute('Overall Width', WIDTH_ATTRIBUTES)).toBe(true)
    expect(matchesAttribute(' width ', WIDTH_ATTRIBUTES)).toBe(true)
    expect(matchesAttribute('Width Under Top', WIDTH_ATTRIBUTES)).toBe(false)
  })
})

describe('dimensionsConflict', () => {
  it('says nothing when the two sources agree closely enough', () => {
    const model = { widthMm: 1600, depthMm: 800, heightMm: 730 }
    const spec = { widthMm: 1605, depthMm: 800, heightMm: 725 }
    expect(dimensionsConflict(model, spec)).toBe('')
  })

  it('names the axis when they do not', () => {
    const model = { widthMm: 160, depthMm: 800, heightMm: 730 }
    const spec = { widthMm: 1600, depthMm: 800, heightMm: 730 }
    expect(dimensionsConflict(model, spec)).toContain('width')
  })

  it('ignores an axis only one source knows about', () => {
    const model = { widthMm: 1600, depthMm: null, heightMm: 730 }
    const spec = { widthMm: 1600, depthMm: 800, heightMm: null }
    expect(dimensionsConflict(model, spec)).toBe('')
  })
})
