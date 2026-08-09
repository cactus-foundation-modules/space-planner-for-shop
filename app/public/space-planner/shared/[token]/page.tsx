import Link from 'next/link'
import { getShopGate } from '@/modules/shop/lib/access'
import { ShopClosedNotice } from '@/modules/shop/components/public/ShopClosedNotice'
import { getPlanByShareToken } from '@/modules/space-planner-for-shop/lib/db/plans'
import { getRoomForAdmin } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { buildBom } from '@/modules/space-planner-for-shop/lib/bom'
import { polygonAreaM2 } from '@/modules/space-planner-for-shop/lib/geometry'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'
import { plannerVisible } from '@/modules/space-planner-for-shop/lib/visibility'

// A shared plan, read-only.
//
// The one route in this module that answers to a secret rather than to a
// session. It is robots-disallowed (lib/robots.ts) because a customer's office
// layout turning up in a search result would be a genuine breach of what "share
// this link with my boss" meant to them.
//
// Deliberately still works in staff-only mode: this page exists because somebody
// pressed share and sent the link to a specific person, and staff-only mode is
// the case where that person is a customer being sent a layout by the shop.
// Killing it would break the one thing a staff-only planner is for. What does go
// is the invitation at the bottom to open the planner, which would only lead to
// a 404.
//
// It renders the item list and the room's numbers rather than the 3D scene: the
// recipient is usually whoever signs the purchase order, and what they want is
// what it costs and what is in it.

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const plan = await getPlanByShareToken(token)
  return {
    title: plan ? `${plan.name} - shared plan` : 'Shared layout',
    robots: { index: false, follow: false },
  }
}

export default async function SharedPlanPage({ params }: { params: Promise<{ token: string }> }) {
  const gate = await getShopGate()
  if (gate.blocked) return <ShopClosedNotice message={gate.message} />

  const { token } = await params
  const plan = await getPlanByShareToken(token)
  // A withdrawn or expired link gets a sentence, not the site's bare 404.
  //
  // By this file's own reckoning the person holding this address is whoever
  // signs the purchase order - somebody who has been sent a link by a customer
  // and has no idea what this site is. "This page doesn't exist" tells them the
  // customer sent them a broken address; the truth is that the link was taken
  // down, and there is a shop at the other end of it.
  if (!plan) {
    return (
      <div style={{ display: 'grid', gap: '0.75rem', maxWidth: '38rem', margin: '0 auto', padding: '2rem 0' }}>
        <h1 style={{ margin: 0 }}>That layout is no longer shared</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          The link has been withdrawn, or the plan it pointed at has been deleted. Whoever sent it to you can share it
          again from their account.
        </p>
        <p style={{ margin: 0 }}>
          <Link href="/" prefetch={false} style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>
            Go to the shop
          </Link>
        </p>
      </div>
    )
  }

  const [room, bom, config, visible] = await Promise.all([
    getRoomForAdmin(plan.roomId),
    buildBom(plan.items, plan.productSnapshot),
    getSplConfigCached(),
    plannerVisible(),
  ])
  const placed = plan.items.items.filter((item) => !item.staged)

  return (
    <div style={{ maxWidth: '52rem', margin: '0 auto', padding: '2rem 1.5rem', display: 'grid', gap: '1.5rem' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 'var(--text-2xl, 1.6rem)' }}>{plan.name}</h1>
        <p style={{ margin: '0.25rem 0 0', color: 'var(--color-text-secondary)' }}>
          {room?.name ?? 'A space'}
          {room && ` · ${polygonAreaM2(room.geometry.vertices).toFixed(1)} m²`} · {placed.length}{' '}
          {placed.length === 1 ? 'item' : 'items'}
        </p>
      </div>

      {bom.missing.length > 0 && (
        <p style={{ border: '1px solid var(--color-border)', borderLeft: '3px solid var(--color-warning, #a16207)', borderRadius: 'var(--radius-sm, 6px)', padding: '0.6rem 0.75rem', margin: 0 }}>
          {bom.missing.length === 1 ? 'One thing in this layout is' : `${bom.missing.length} things in this plan are`} no longer
          in the shop: {bom.missing.join(', ')}. {bom.missing.length === 1 ? 'It is' : 'They are'} still listed and priced below,
          at the price when the plan was made, and marked as no longer sold.
        </p>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left" style={{ padding: '0.4rem 0.5rem 0.4rem 0', borderBottom: '1px solid var(--color-border)' }}>Item</th>
            <th align="right" style={{ padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)' }}>Qty</th>
            <th align="right" style={{ padding: '0.4rem 0 0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {bom.lines.map((line) => (
            <tr key={line.productId}>
              <td style={{ padding: '0.4rem 0.5rem 0.4rem 0', borderBottom: '1px solid var(--color-border)' }}>
                {line.name}
                {line.approximate && <span style={{ color: 'var(--color-text-secondary)' }}> (approx. size)</span>}
                {/* The one page a purchase order gets signed off was the one
                    page with no way to tell which rows had been withdrawn -
                    they stay in the table and in the total, which is right, but
                    the admin screen has carried this badge all along. */}
                {line.fromSnapshot && <span style={{ color: 'var(--color-text-secondary)' }}> (no longer sold)</span>}
              </td>
              <td align="right" style={{ padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)' }}>{line.quantity}</td>
              <td align="right" style={{ padding: '0.4rem 0 0.4rem 0.5rem', borderBottom: '1px solid var(--color-border)' }}>{line.lineTotalFormatted}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2} align="right" style={{ padding: '0.6rem 0.5rem 0 0', fontWeight: 600 }}>Total {bom.taxSuffix}</td>
            <td align="right" style={{ padding: '0.6rem 0 0 0.5rem', fontWeight: 600 }}>{bom.totalFormatted}</td>
          </tr>
        </tfoot>
      </table>

      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm, 0.875rem)', margin: 0 }}>{bom.disclaimer}</p>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm, 0.875rem)', margin: 0 }}>{config.guidanceDisclaimer}</p>

      {visible && (
        <div>
          {/* It opens an empty planner, and always did: there is no copy
              parameter anywhere in the module, so "copy this" was a promise
              nothing kept. Said as what the link does instead. */}
          <Link href="/space-planner" prefetch={false} style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>
            Plan a space of your own →
          </Link>
        </div>
      )}
    </div>
  )
}
