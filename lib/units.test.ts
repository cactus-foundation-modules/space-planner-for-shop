import { describe, expect, it } from 'vitest'
import { formatImperial, formatLength, formatMetric, parseLengthMm } from '@/modules/space-planner-for-shop/lib/units'

describe('parseLengthMm', () => {
  it('reads the metric units people actually type', () => {
    expect(parseLengthMm('1200mm')).toBe(1200)
    expect(parseLengthMm('1200 mm')).toBe(1200)
    expect(parseLengthMm('120cm')).toBe(1200)
    expect(parseLengthMm('1.2m')).toBe(1200)
    expect(parseLengthMm('2.4 metres')).toBe(2400)
  })

  it('reads feet and inches in every shape they get written', () => {
    expect(parseLengthMm('8ft')).toBe(2438)
    expect(parseLengthMm("8'")).toBe(2438)
    expect(parseLengthMm(`7' 10"`)).toBe(2388)
    expect(parseLengthMm('7ft 10in')).toBe(2388)
  })

  it('applies the caller convention only to a bare number', () => {
    expect(parseLengthMm('1200')).toBe(1200)
    expect(parseLengthMm('120', 'cm')).toBe(1200)
    // A named unit always wins over the convention - the text knows better.
    expect(parseLengthMm('1200mm', 'cm')).toBe(1200)
  })

  it('strips thousands separators', () => {
    expect(parseLengthMm('1,200mm')).toBe(1200)
  })

  it('refuses to guess at anything that is not a length', () => {
    expect(parseLengthMm('')).toBeNull()
    expect(parseLengthMm('made to order')).toBeNull()
    expect(parseLengthMm('various')).toBeNull()
    expect(parseLengthMm('1200 x 800')).toBeNull()
  })
})

describe('formatting', () => {
  it('shows millimetres under a metre and metres above', () => {
    expect(formatMetric(730)).toBe('730 mm')
    expect(formatMetric(2400)).toBe('2.4 m')
    expect(formatMetric(6250)).toBe('6.25 m')
  })

  it('rounds imperial to the nearest inch', () => {
    expect(formatImperial(2438)).toBe(`8'`)
    expect(formatImperial(2388)).toBe(`7' 10"`)
    expect(formatImperial(250)).toBe('10"')
  })

  it('follows the room units', () => {
    expect(formatLength(2400, 'metric')).toBe('2.4 m')
    expect(formatLength(2438, 'imperial')).toBe(`8'`)
  })
})
