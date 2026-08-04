'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { readCart, watchCart } from '@/modules/space-planner-for-shop/lib/client/cart-bridge'

// The link into the planner, wherever it is placed.
//
// It is a plain link rather than anything cleverer, which is the point: opening
// the planner from the basket costs the server nothing at all. The hand-off is
// entirely client-side - the planner reads the basket through shop's own cart
// utility once it is open - so there is no new route, no round trip and nothing
// to rate limit.

export type PlannerLaunchButtonProps = {
  label: string
  /** 'cart' stages the basket; 'product' stages one variant; 'plain' opens empty. */
  from: 'cart' | 'product' | 'plain'
  productId?: string
  /** Secondary everywhere by default: the planner is an aid to buying, never a diversion from it. */
  primary?: boolean
  /** Editor preview - renders the same markup without being a live link. */
  preview?: boolean
  /** Hide entirely on an empty basket. A basket with nothing in it has nothing to plan. */
  hideWhenCartEmpty?: boolean
}

export function PlannerLaunchButton(props: PlannerLaunchButtonProps) {
  const [empty, setEmpty] = useState(false)
  const router = useRouter()

  useEffect(() => {
    if (!props.hideWhenCartEmpty) return
    // Read once AND subscribed. Subscribing alone does not fire, so the state
    // only ever settled when the basket next changed - which on the one page
    // this matters on, an empty basket, it never does. The button sat there
    // offering to plan a room around nothing.
    const check = () => setEmpty(readCart().length === 0)
    check()
    return watchCart(check)
  }, [props.hideWhenCartEmpty])

  if (props.hideWhenCartEmpty && empty && !props.preview) return null

  const baseHref = props.from === 'cart' ? '/space-planner?from=cart' : '/space-planner'
  const className = `spl-btn spl-launch${props.primary ? ' spl-btn-primary' : ''}`

  if (props.preview) {
    return (
      <span className={className} aria-hidden>
        {props.label}
      </span>
    )
  }

  return (
    <Link
      href={baseHref}
      prefetch={false}
      className={className}
      onClick={(event) => {
        // On a product page the block has no product of its own: it is one
        // shared template rendered for every product, and shop's context
        // injection names the block types it fills in - which is shop's list,
        // not ours. Reading the slug out of the address bar at click time needs
        // nothing from shop, is exactly as correct (it is the slug that chose
        // the page), and keeps the server-rendered href stable so there is
        // nothing to mismatch on hydration.
        if (props.from !== 'product') return
        const productId = props.productId
        const slug = window.location.pathname.split('/').filter(Boolean).pop() ?? ''
        const target = productId
          ? `/space-planner?product=${encodeURIComponent(productId)}`
          : slug
            ? `/space-planner?productSlug=${encodeURIComponent(slug)}`
            : '/space-planner'
        event.preventDefault()
        router.push(target)
      }}
    >
      {props.label}
    </Link>
  )
}
