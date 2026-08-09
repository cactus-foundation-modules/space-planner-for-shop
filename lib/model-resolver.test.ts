import { beforeEach, describe, expect, it, vi } from 'vitest'

// The add-on context path, which had no test at all while it was a sequential
// loop and now has one because it is a batched one. What is pinned here is not
// the batching itself - that is a performance property - but everything the
// batching had to preserve: which shelf a tagged file is found on, that a
// missing file leaves NO entry so the scene falls back to the base model, and
// that the base entry's mount and recorded real size still reach the variant.
// The refactor dropped those last two and they were only caught by reading the
// diff, which is precisely the sort of thing a test should have been holding.

const getModelsForProducts = vi.fn()
const getVariationParents = vi.fn()
const getModelMetaForModels = vi.fn()
const getModelMetaForProducts = vi.fn()
const getFabricConfig = vi.fn()
const resolveFabricForChild = vi.fn()
const getVariationChildrenForProducts = vi.fn()
const getFirstVariationChildren = vi.fn()

vi.mock('@/lib/media/asset-token', () => ({ signAssetUrl: (url: string) => `${url}?sig=x` }))
vi.mock('@/modules/product-3d-views-for-shop/lib/db/fabric-config', () => ({
  getFabricConfig: (...args: unknown[]) => getFabricConfig(...args),
}))
vi.mock('@/modules/product-3d-views-for-shop/lib/db/models', () => ({
  getModelsForProducts: (...args: unknown[]) => getModelsForProducts(...args),
  getVariationChildrenForProducts: (...args: unknown[]) => getVariationChildrenForProducts(...args),
}))
vi.mock('@/modules/product-3d-views-for-shop/lib/fabric/resolve', () => ({
  resolveFabricForChild: (...args: unknown[]) => resolveFabricForChild(...args),
}))
vi.mock('@/modules/space-planner-for-shop/lib/db/model-meta', () => ({
  getModelMetaForModels: (...args: unknown[]) => getModelMetaForModels(...args),
  getModelMetaForProducts: (...args: unknown[]) => getModelMetaForProducts(...args),
}))
vi.mock('@/modules/space-planner-for-shop/lib/spec-attributes', () => ({
  getFirstVariationChildren: (...args: unknown[]) => getFirstVariationChildren(...args),
  getVariationParents: (...args: unknown[]) => getVariationParents(...args),
}))

const { clearFabricCache, plannerModelKey, resolveModelsForProducts } = await import(
  '@/modules/space-planner-for-shop/lib/model-resolver'
)

const DESK = 'desk-1'
const LISTING = 'desk-listing'
const SCREENS = 'screens'

function model(overrides: Record<string, unknown> = {}) {
  return { id: 'm1', productId: DESK, url: 'https://cdn/desk.glb', format: 'glb', context: '', ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearFabricCache()
  getVariationParents.mockResolvedValue(new Map([[DESK, LISTING]]))
  getVariationChildrenForProducts.mockResolvedValue(new Map())
  getFirstVariationChildren.mockResolvedValue(new Map())
  getModelMetaForProducts.mockResolvedValue(new Map())
  getModelMetaForModels.mockResolvedValue(new Map())
  getFabricConfig.mockResolvedValue(null)
  resolveFabricForChild.mockResolvedValue(null)
})

describe('resolveModelsForProducts, add-on contexts', () => {
  it('takes the tagged file off the child before the listing', async () => {
    getModelsForProducts.mockResolvedValue([
      model(),
      model({ id: 'm-child', context: SCREENS, url: 'https://cdn/child-with-screens.glb' }),
      model({ id: 'm-parent', productId: LISTING, context: SCREENS, url: 'https://cdn/listing-with-screens.glb' }),
    ])

    const out = await resolveModelsForProducts([DESK], { contexts: [{ productId: DESK, context: SCREENS, extraValueIds: [] }] })
    expect(out.get(plannerModelKey(DESK, SCREENS))?.plainUrl).toBe('https://cdn/child-with-screens.glb')
  })

  it('falls back to the listing when only it carries the combination', async () => {
    getModelsForProducts.mockResolvedValue([
      model(),
      model({ id: 'm-parent', productId: LISTING, context: SCREENS, url: 'https://cdn/listing-with-screens.glb' }),
    ])

    const out = await resolveModelsForProducts([DESK], { contexts: [{ productId: DESK, context: SCREENS, extraValueIds: [] }] })
    expect(out.get(plannerModelKey(DESK, SCREENS))?.plainUrl).toBe('https://cdn/listing-with-screens.glb')
  })

  it('stores nothing at all when no file carries the combination', async () => {
    getModelsForProducts.mockResolvedValue([model()])

    const out = await resolveModelsForProducts([DESK], { contexts: [{ productId: DESK, context: SCREENS, extraValueIds: [] }] })
    // Absent, not a placeholder: the scene's lookup falls through to the base
    // entry, which is how a desk with no combined file still draws as a desk.
    expect(out.has(plannerModelKey(DESK, SCREENS))).toBe(false)
    expect(out.has(DESK)).toBe(true)
  })

  it('keeps the base entry beside the variant rather than replacing it', async () => {
    getModelsForProducts.mockResolvedValue([model(), model({ id: 'm2', context: SCREENS, url: 'https://cdn/combined.glb' })])

    const out = await resolveModelsForProducts([DESK], { contexts: [{ productId: DESK, context: SCREENS, extraValueIds: [] }] })
    expect(out.get(DESK)?.plainUrl).toBe('https://cdn/desk.glb')
    expect(out.get(plannerModelKey(DESK, SCREENS))?.plainUrl).toBe('https://cdn/combined.glb')
  })

  it('carries the base entry\'s mount to the variant', async () => {
    getModelMetaForProducts.mockResolvedValue(new Map([[DESK, { mountType: 'wall' }]]))
    getModelsForProducts.mockResolvedValue([model(), model({ id: 'm2', context: SCREENS, url: 'https://cdn/combined.glb' })])

    const out = await resolveModelsForProducts([DESK], { contexts: [{ productId: DESK, context: SCREENS, extraValueIds: [] }] })
    expect(out.get(plannerModelKey(DESK, SCREENS))?.mountOverride).toBe('wall')
  })

  it('applies the file\'s own yaw correction to the variant', async () => {
    getModelMetaForModels.mockResolvedValue(new Map([['m2', { yawOffsetDegrees: 90, noDecimation: true }]]))
    getModelsForProducts.mockResolvedValue([model(), model({ id: 'm2', context: SCREENS, url: 'https://cdn/combined.glb' })])

    const out = await resolveModelsForProducts([DESK], { contexts: [{ productId: DESK, context: SCREENS, extraValueIds: [] }] })
    expect(out.get(plannerModelKey(DESK, SCREENS))).toMatchObject({ yawOffsetDeg: 90, noDecimation: true })
  })

  it('does not resolve the same combination twice', async () => {
    getModelsForProducts.mockResolvedValue([model(), model({ id: 'm2', context: SCREENS, url: 'https://cdn/combined.glb' })])

    await resolveModelsForProducts([DESK], {
      contexts: [
        { productId: DESK, context: SCREENS, extraValueIds: [] },
        { productId: DESK, context: SCREENS, extraValueIds: [] },
      ],
    })
    // The contexts are resolved in ONE batched call carrying one deduplicated
    // model id, rather than a call per context in a row - the point of the batch.
    const lastCall = getModelMetaForModels.mock.calls.at(-1)
    expect(lastCall?.[0]).toEqual(['m2'])
    // And the duplicate is dropped before any colours are worked out, rather
    // than both copies racing for the same cache entry and both missing it.
    // Twice: once for the base model, once for the single surviving context.
    // Without the dedupe it is three, concurrently, for the same answer.
    expect(getFabricConfig).toHaveBeenCalledTimes(2)
  })

  it('ignores a request with an empty context tag', async () => {
    getModelsForProducts.mockResolvedValue([model()])

    const out = await resolveModelsForProducts([DESK], { contexts: [{ productId: DESK, context: '', extraValueIds: [] }] })
    expect([...out.keys()]).toEqual([DESK])
  })

  it('lets one bad combination fail without taking the others with it', async () => {
    getModelsForProducts.mockResolvedValue([
      model(),
      model({ id: 'm-bad', context: 'bad', url: 'https://cdn/bad.glb' }),
      model({ id: 'm-good', context: SCREENS, url: 'https://cdn/combined.glb' }),
    ])
    getFabricConfig.mockResolvedValue({ id: 'cfg' })
    resolveFabricForChild.mockImplementation(async () => {
      throw new Error('that variation has no colours to be had')
    })

    const out = await resolveModelsForProducts([DESK], {
      contexts: [
        { productId: DESK, context: 'bad', extraValueIds: [] },
        { productId: DESK, context: SCREENS, extraValueIds: [] },
      ],
    })
    // Both throw, both draw as the base model, and neither takes the response
    // down with it - a duller desk is not a broken room.
    expect(out.has(DESK)).toBe(true)
    expect(out.has(plannerModelKey(DESK, 'bad'))).toBe(false)
  })
})
