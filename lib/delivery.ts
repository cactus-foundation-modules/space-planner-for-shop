import { moduleExtensionPointComponents } from '@/lib/modules/extension-points'
import type { Bom } from '@/modules/space-planner-for-shop/lib/bom'

// "How much" is always followed by "when", and with a good few thousand products
// made to order that is not a nicety on a fit-out plan.
//
// advanced-shipping-for-shop already answers exactly this question, batched, per
// line, with a caller-supplied reference echoed back so the answers map straight
// onto item-list rows. What it does not yet do is publish an extension point for
// it, and that is the seam this file waits on.
//
// It is deliberately NOT a build-time import. advanced-shipping is optional, and
// on an install without it '@/modules/advanced-shipping-for-shop/...' is a path
// that does not exist - a static import would fail that site's build rather than
// quietly drop a column. So the provider is looked up in the generated
// extension-point registry by name, and its absence means "no delivery column",
// which is the correct behaviour on a shop that has no delivery estimates to
// give.

const POINT = 'shop.delivery-estimates'

export type DeliveryEstimate = {
  /** Per item-list row, keyed by product id. */
  byProduct: Record<string, { targetDate: string | null; label: string }>
  /** "Arrives in 2 deliveries", with dates and what is in each. */
  deliveries: Array<{ targetDate: string | null; label: string; items: string[] }>
}

type EstimateProvider = (
  inputs: Array<{ ref: string; productId: string; quantity: number }>,
) => Promise<DeliveryEstimate | null>

function getProvider(): EstimateProvider | null {
  const map = moduleExtensionPointComponents[POINT] as Record<string, EstimateProvider> | undefined
  if (!map) return null
  const first = Object.values(map)[0]
  return typeof first === 'function' ? first : null
}

/** Null means "this shop cannot answer that", not "something went wrong". */
export async function estimateDelivery(bom: Bom): Promise<DeliveryEstimate | null> {
  const provider = getProvider()
  if (!provider) return null
  if (bom.lines.length === 0) return null

  try {
    return await provider(
      bom.lines.map((line) => ({ ref: line.productId, productId: line.productId, quantity: line.quantity })),
    )
  } catch {
    // A delivery estimate is a bonus column. It never takes the item list down
    // with it.
    return null
  }
}

/** Whether the column should appear at all, for the UI to decide its header row. */
export function deliveryEstimatesAvailable(): boolean {
  return getProvider() !== null
}
