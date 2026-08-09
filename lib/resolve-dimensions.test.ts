import { describe, expect, it } from 'vitest'
import { readAttributeDimensions, resolveOne, underTopFrom } from '@/modules/space-planner-for-shop/lib/resolve-dimensions'
import type { MountType, SplDimensions } from '@/modules/space-planner-for-shop/lib/types'

const NO_DEFAULTS = new Map<string, { widthMm: number | null; depthMm: number | null; heightMm: number | null; mountType: MountType }>()

function base(overrides: Partial<Parameters<typeof resolveOne>[0]> = {}) {
  return {
    productId: 'p1',
    productUpdatedAt: new Date('2026-08-01T00:00:00Z'),
    cached: null as SplDimensions | null,
    values: [] as Array<{ attribute: string; label: string }>,
    categoryId: null as string | null,
    categoryDefaults: NO_DEFAULTS,
    mountOverride: null as MountType | null,
    ...overrides,
  }
}

describe('readAttributeDimensions', () => {
  it('reads the three axes off separate attributes', () => {
    const result = readAttributeDimensions([
      { attribute: 'Overall Width', label: '1600mm' },
      { attribute: 'Overall Depth', label: '800mm' },
      { attribute: 'Overall Height (spec)', label: '730mm' },
    ])
    expect(result).toMatchObject({ widthMm: 1600, depthMm: 800, heightMm: 730 })
  })

  it('never mistakes "Width Under Top" for a width', () => {
    const result = readAttributeDimensions([{ attribute: 'Width Under Top', label: '1200mm' }])
    expect(result.widthMm).toBeNull()
  })

  it('reads a combined dimensions column', () => {
    const result = readAttributeDimensions([{ attribute: 'Dimensions', label: 'W1600 x D800 x H730mm' }])
    expect(result).toMatchObject({ widthMm: 1600, depthMm: 800, heightMm: 730 })
  })

  it('collects what it could not read instead of silently dropping it', () => {
    const result = readAttributeDimensions([{ attribute: 'Overall Width', label: 'please enquire' }])
    expect(result.widthMm).toBeNull()
    expect(result.junk).toContain('please enquire')
  })

  // The rows arrive with no ORDER BY, so both orders are things the database
  // really does hand over - and 294 Deskwell products publish two different
  // heights. Whichever way round they turn up, the preferred name has to win.
  it('prefers the earlier attribute name whichever order the rows arrive in', () => {
    const specFirst = readAttributeDimensions([
      { attribute: 'Overall Height (Spec)', label: '108cm' },
      { attribute: 'Overall Height', label: '110.4cm' },
    ])
    const specLast = readAttributeDimensions([
      { attribute: 'Overall Height', label: '110.4cm' },
      { attribute: 'Overall Height (Spec)', label: '108cm' },
    ])
    expect(specFirst.heightMm).toBe(1080)
    expect(specLast.heightMm).toBe(1080)
    expect(specLast.parsedFrom).toContain('108cm')
    expect(specLast.parsedFrom).not.toContain('110.4cm')
  })

  it('falls past a preferred name it cannot read rather than giving up on the axis', () => {
    const result = readAttributeDimensions([
      { attribute: 'Overall Width', label: 'please enquire' },
      { attribute: 'Width', label: '1600mm' },
    ])
    expect(result.widthMm).toBe(1600)
    expect(result.junk).toContain('please enquire')
  })

  it('still reads a combined column when a named axis sits beside it', () => {
    const result = readAttributeDimensions([
      { attribute: 'Overall Width', label: '1600mm' },
      { attribute: 'Dimensions', label: 'W1800 x D800 x H730mm' },
    ])
    expect(result).toMatchObject({ widthMm: 1600, depthMm: 800, heightMm: 730 })
  })
})

describe('underTopFrom', () => {
  it('picks up the clearance measurements the fit check needs', () => {
    expect(underTopFrom([
      { attribute: 'Height Under Top', label: '620mm' },
      { attribute: 'Width Under Top', label: '1400mm' },
    ])).toEqual({ heightMm: 620, widthMm: 1400 })
  })
})

describe('resolveOne', () => {
  it('uses parsed attributes when there is no measured model', () => {
    const result = resolveOne(base({
      values: [
        { attribute: 'Overall Width', label: '1600mm' },
        { attribute: 'Overall Depth', label: '800mm' },
        { attribute: 'Overall Height', label: '730mm' },
      ],
    }))
    expect(result).toMatchObject({ widthMm: 1600, depthMm: 800, heightMm: 730, source: 'attribute' })
  })

  it('fills a missing axis from the category default and says so', () => {
    const defaults = new Map([['cat-desks', { widthMm: 1400, depthMm: 800, heightMm: 730, mountType: 'floor' as MountType }]])
    const result = resolveOne(base({ categoryId: 'cat-desks', categoryDefaults: defaults }))
    expect(result).toMatchObject({ widthMm: 1400, depthMm: 800, heightMm: 730, source: 'category_default' })
  })

  it('calls a size approximate when any part of it came off a fallback', () => {
    const defaults = new Map([['cat-desks', { widthMm: 1400, depthMm: 800, heightMm: 730, mountType: 'floor' as MountType }]])
    const result = resolveOne(base({
      categoryId: 'cat-desks',
      categoryDefaults: defaults,
      // A real width off the spec sheet, and nothing at all for the other two.
      values: [{ attribute: 'Overall Width', label: '1600mm' }],
    }))
    expect(result.widthMm).toBe(1600)
    expect(result.depthMm).toBe(800)
    // Badged as approximate, because two of the three axes are a guess.
    expect(result.source).toBe('category_default')
  })

  // The junk tail's whole contract: a product that reads a good width and a bad
  // height belongs on the "could not read" card, and its own good text does not.
  it('records unreadable text even when another axis read perfectly well', () => {
    const result = resolveOne(base({
      values: [
        { attribute: 'Overall Width', label: '1600mm' },
        { attribute: 'Overall Height', label: 'please enquire' },
      ],
    }))
    expect(result.widthMm).toBe(1600)
    expect(result.junkText).toContain('please enquire')
    // And the successful text stays where it belongs, out of the junk.
    expect(result.junkText).not.toContain('1600mm')
    expect(result.parsedFrom).toContain('1600mm')
  })

  it('leaves the junk empty for a product with nothing to choke on', () => {
    expect(resolveOne(base()).junkText).toBe('')
  })

  it('never blocks a placement, even with nothing to go on', () => {
    const result = resolveOne(base())
    expect(result.source).toBe('marker')
    expect(result.widthMm).toBeGreaterThan(0)
    expect(result.heightMm).toBeGreaterThan(0)
  })

  it('keeps a measured model size and does not let a spec edit overwrite it', () => {
    const cached: SplDimensions = {
      productId: 'p1',
      widthMm: 1598,
      depthMm: 802,
      heightMm: 731,
      source: 'glb',
      parsedFrom: '',
      junkText: '',
      conflict: false,
      conflictNote: '',
      mountType: 'floor',
      productUpdatedAt: new Date('2026-07-01T00:00:00Z'),
      stale: false,
      resolvedAt: new Date('2026-07-01T00:00:00Z'),
    }
    const result = resolveOne(base({
      cached,
      values: [{ attribute: 'Overall Width', label: '1600mm' }],
    }))
    expect(result).toMatchObject({ widthMm: 1598, source: 'glb', conflict: false })
  })

  it('flags a model and a spec sheet that disagree, rather than picking one', () => {
    const cached: SplDimensions = {
      productId: 'p1',
      widthMm: 160,
      depthMm: 800,
      heightMm: 730,
      source: 'glb',
      parsedFrom: '',
      junkText: '',
      conflict: false,
      conflictNote: '',
      mountType: 'floor',
      productUpdatedAt: null,
      stale: false,
      resolvedAt: new Date(),
    }
    const result = resolveOne(base({
      cached,
      values: [
        { attribute: 'Overall Width', label: '1600mm' },
        { attribute: 'Overall Depth', label: '800mm' },
        { attribute: 'Overall Height', label: '730mm' },
      ],
    }))
    expect(result.conflict).toBe(true)
    expect(result.conflictNote).toContain('width')
  })

  it('keeps a size the shopper typed', () => {
    const cached: SplDimensions = {
      productId: 'p1',
      widthMm: 2000,
      depthMm: 900,
      heightMm: 700,
      source: 'manual',
      parsedFrom: '',
      junkText: '',
      conflict: false,
      conflictNote: '',
      mountType: 'floor',
      productUpdatedAt: null,
      stale: false,
      resolvedAt: new Date(),
    }
    const result = resolveOne(base({ cached, values: [{ attribute: 'Overall Width', label: '1600mm' }] }))
    expect(result).toMatchObject({ widthMm: 2000, source: 'manual' })
  })

  it('prefers a per-product mount override over the category', () => {
    const defaults = new Map([['cat', { widthMm: 400, depthMm: 400, heightMm: 400, mountType: 'floor' as MountType }]])
    const result = resolveOne(base({ categoryId: 'cat', categoryDefaults: defaults, mountOverride: 'desk-surface' }))
    expect(result.mountType).toBe('desk-surface')
  })

  // Which fallback answered decides the badge, and the badge is the whole of the
  // ladder's promise that a guess is never dressed up as a measurement.
  describe('what the size is badged as', () => {
    const sizedCategory = (mount: MountType = 'floor') =>
      new Map([['cat', { widthMm: 700, depthMm: 700, heightMm: 700, mountType: mount }]])
    /** A category somebody saved with only a mount type - no measurements at all. */
    const emptyCategory = (mount: MountType = 'floor') =>
      new Map([['cat', { widthMm: null, depthMm: null, heightMm: null, mountType: mount }]])

    it('says "typical for its category" when the category actually supplied a size', () => {
      const result = resolveOne(base({ categoryId: 'cat', categoryDefaults: sizedCategory() }))
      expect(result.source).toBe('category_default')
      expect(result.widthMm).toBe(700)
    })

    it('still says "no idea" when the category default is blank', () => {
      // The defect this pins: the badge tested whether a category default ROW
      // existed rather than whether it supplied anything, so saving one with all
      // three boxes empty re-badged every product under it as measured while the
      // generic block was still doing all the work.
      const result = resolveOne(base({ categoryId: 'cat', categoryDefaults: emptyCategory() }))
      expect(result.source).toBe('marker')
      expect(result.widthMm).toBe(800)
    })

    it('does not claim a category answered when there is no category at all', () => {
      const result = resolveOne(base())
      expect(result.source).toBe('marker')
    })

    it('leaves a fully specified spec sheet alone', () => {
      const result = resolveOne(base({
        categoryId: 'cat',
        categoryDefaults: sizedCategory(),
        values: [
          { attribute: 'Overall Width', label: '1600mm' },
          { attribute: 'Overall Depth', label: '800mm' },
          { attribute: 'Overall Height', label: '730mm' },
        ],
      }))
      expect(result.source).toBe('attribute')
      expect(result.widthMm).toBe(1600)
    })

    it('drops to the category badge when the spec sheet only half answers', () => {
      const result = resolveOne(base({
        categoryId: 'cat',
        categoryDefaults: sizedCategory(),
        values: [{ attribute: 'Overall Width', label: '1600mm' }],
      }))
      expect(result.source).toBe('category_default')
      expect(result.widthMm).toBe(1600)
      expect(result.depthMm).toBe(700)
    })

    it('marks a half-answered spec sheet as a guess when the category is blank', () => {
      const result = resolveOne(base({
        categoryId: 'cat',
        categoryDefaults: emptyCategory(),
        values: [{ attribute: 'Overall Width', label: '1600mm' }],
      }))
      expect(result.source).toBe('marker')
      expect(result.widthMm).toBe(1600)
      expect(result.depthMm).toBe(600)
    })

    it('takes the mount type from a blank category even so', () => {
      // Blank of measurements is not blank of meaning: somebody may have opened
      // that dialog purely to say these things sit on a desk.
      const result = resolveOne(base({ categoryId: 'cat', categoryDefaults: emptyCategory('desk-surface') }))
      expect(result.mountType).toBe('desk-surface')
    })
  })
})
