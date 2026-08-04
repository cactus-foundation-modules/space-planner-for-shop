import Link from 'next/link'
import { notFound } from 'next/navigation'
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
    title: plan ? `${plan.name} - shared plan` : 'Shared plan',
    robots: { index: false, follow: false },
  }
}

export default async function SharedPlanPage({ params }: { params: Promise<{ token: string }> }) {
  const gate = await getShopGate()
  if (gate.blocked) return <ShopClosedNotice message={gate.message} />

  const { token } = await params
  const plan = await getPlanByShareToken(token)
  if (!plan) notFound()

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
        <p style={{ margin: '0.25rem 0 0', color: 'var(--color-text-muted)' }}>
          {room?.name ?? 'A room'}
          {room && ` · ${polygonAreaM2(room.geometry.vertices).toFixed(1)} m²`} · {placed.length}{' '}
          {placed.length === 1 ? 'item' : 'items'}
        </p>
      </div>

      {bom.missing.length > 0 && (
        <p style={{ border: '1px solid var(--color-border)', borderLeft: '3px solid var(--color-warning, #a16207)', borderRadius: 'var(--radius-sm, 6px)', padding: '0.6rem 0.75rem', margin: 0 }}>
          {bom.missing.length === 1 ? 'One thing in this plan is' : `${bom.missing.length} things in this plan are`} no longer
          in the shop: {bom.missing.join(', ')}. The rest is unchanged.
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
                {line.approximate && <span style={{ color: 'var(--color-text-muted)' }}> (approx. size)</span>}
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

      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm, 0.875rem)', margin: 0 }}>{bom.disclaimer}</p>
      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm, 0.875rem)', margin: 0 }}>{config.guidanceDisclaimer}</p>

      {visible && (
        <div>
          <Link href="/space-planner" prefetch={false} style={{ color: 'var(--color-primary)' }}>
            Copy this into your own planner →
          </Link>
        </div>
      )}
    </div>
  )
}
