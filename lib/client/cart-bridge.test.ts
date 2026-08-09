import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CartLine } from '@/modules/shop/components/public/cart'

// The basket round trip, which is the module's headline journey: basket → "plan
// your space" → put them all in the room → Add to basket. Every line staged
// from the basket carries the basket's own lineId back with it, and shop's
// addToCart is `existing.quantity += quantity` - so this used to hand back a
// basket of eight desks under a message saying four had been added.

let cart: CartLine[] = []

vi.mock('@/modules/shop/components/public/cart', () => ({
  cartLineKey: (line: { productId: string; lineId?: string }) => line.lineId ?? line.productId,
  getCart: () => cart,
  subscribeCart: () => () => {},
  addToCart: (productId: string, quantity: number, opts?: { lineId?: string; meta?: Record<string, unknown> }) => {
    const personalised = Boolean(opts?.meta || opts?.lineId)
    const index = personalised
      ? opts?.lineId
        ? cart.findIndex((l) => l.lineId === opts.lineId)
        : -1
      : cart.findIndex((l) => l.productId === productId && !l.lineId)
    if (index >= 0) {
      const existing = cart[index] as CartLine
      existing.quantity += quantity
      return
    }
    cart.unshift({ productId, quantity, ...(personalised ? { lineId: opts?.lineId ?? 'new', meta: opts?.meta } : {}) })
  },
}))

const { addPlanToCart } = await import('@/modules/space-planner-for-shop/lib/client/cart-bridge')

beforeEach(() => {
  cart = []
})

describe('addPlanToCart', () => {
  it('does not double a basket the plan was staged from', () => {
    cart = [{ productId: 'desk', quantity: 4, lineId: 'L1' }]

    const result = addPlanToCart([{ productId: 'desk', quantity: 4, basketLine: { lineId: 'L1', meta: null } }])

    expect(result).toMatchObject({ ok: true, added: 0 })
    expect(cart[0]?.quantity).toBe(4)
  })

  it('does not double a plain line either', () => {
    // No lineId and no meta, so shop matches on product id and increments that.
    cart = [{ productId: 'chair', quantity: 3 }]

    addPlanToCart([{ productId: 'chair', quantity: 3, basketLine: { lineId: null, meta: null } }])

    expect(cart[0]?.quantity).toBe(3)
  })

  it('tops up when the room holds more than the basket did', () => {
    cart = [{ productId: 'desk', quantity: 4, lineId: 'L1' }]

    const result = addPlanToCart([{ productId: 'desk', quantity: 6, basketLine: { lineId: 'L1', meta: null } }])

    expect(result).toMatchObject({ ok: true, added: 1 })
    expect(cart[0]?.quantity).toBe(6)
  })

  it('leaves the basket alone when the room holds fewer', () => {
    // "Add to basket" is not a licence to take things out of it.
    cart = [{ productId: 'desk', quantity: 4, lineId: 'L1' }]

    addPlanToCart([{ productId: 'desk', quantity: 2, basketLine: { lineId: 'L1', meta: null } }])

    expect(cart[0]?.quantity).toBe(4)
  })

  it('still adds something the basket has never held', () => {
    cart = [{ productId: 'desk', quantity: 4, lineId: 'L1' }]

    const result = addPlanToCart([{ productId: 'pedestal', quantity: 2 }])

    expect(result).toMatchObject({ ok: true, added: 1 })
    expect(cart.find((line) => line.productId === 'pedestal')?.quantity).toBe(2)
    expect(cart.find((line) => line.productId === 'desk')?.quantity).toBe(4)
  })

  it('tops up a grouped line and its invisible companions together', () => {
    cart = [
      { productId: 'desk', quantity: 2, lineId: 'L1' },
      { productId: 'screen', quantity: 2, lineId: 'L2' },
    ]

    addPlanToCart([
      {
        productId: 'desk',
        quantity: 3,
        basketLine: { lineId: 'L1', meta: null },
        basketBundle: [{ productId: 'screen', lineId: 'L2', meta: null, qtyPerMain: 1 }],
      },
    ])

    expect(cart.find((line) => line.lineId === 'L1')?.quantity).toBe(3)
    expect(cart.find((line) => line.lineId === 'L2')?.quantity).toBe(3)
  })

  it('refuses an empty plan rather than reporting a success', () => {
    expect(addPlanToCart([])).toMatchObject({ ok: false })
  })
})
