import Link from 'next/link'
import { getMemberFromCookie } from '@/lib/members/session'
import { getMemberAreaPath } from '@/lib/members/paths'
import { listRoomsForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { listPlansForRoom } from '@/modules/space-planner-for-shop/lib/db/plans'
import { polygonAreaM2 } from '@/modules/space-planner-for-shop/lib/geometry'

export const metadata = { title: 'My spaces' }

// The library: rooms, and the layouts inside them.
//
// Measure once, compare layouts - that is what a fit-out buyer is actually doing
// when they ask for a quote, and it is why a room is a first-class thing here
// rather than a property of a plan.
export default async function SpacesPage() {
  const member = await getMemberFromCookie()
  if (!member) {
    return (
      <div style={{ maxWidth: '40rem', margin: '0 auto', padding: '3rem 1.5rem', display: 'grid', gap: '0.75rem' }}>
        <h1 style={{ margin: 0 }}>My spaces</h1>
        <p style={{ color: 'var(--color-text-muted)' }}>
          Sign in to see the rooms you have saved. Anything you were part-way through is still in this browser.
        </p>
        <Link href={`/${getMemberAreaPath()}/login`} prefetch={false} style={{ color: 'var(--color-primary)' }}>
          Sign in →
        </Link>
      </div>
    )
  }

  const rooms = await listRoomsForMember(member.id)
  const withPlans = await Promise.all(
    rooms.map(async (entry) => ({ entry, plans: await listPlansForRoom(entry.room.id, member.id) })),
  )

  return (
    <div style={{ maxWidth: '52rem', margin: '0 auto', padding: '2rem 1.5rem', display: 'grid', gap: '1.5rem' }}>
      <style
        dangerouslySetInnerHTML={{
          __html: `.spl-space-row:hover { border-color: var(--color-primary) !important; }
.spl-space-row:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }`,
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>My spaces</h1>
        <Link href="/space-planner" prefetch={false} style={{ color: 'var(--color-primary)' }}>
          Plan another →
        </Link>
      </div>

      {withPlans.length === 0 && (
        <p style={{ color: 'var(--color-text-muted)' }}>
          Nothing saved yet. <Link href="/space-planner" style={{ color: 'var(--color-primary)' }}>Draw your first room</Link> - it takes a minute.
        </p>
      )}

      {withPlans.map(({ entry, plans }) => (
        <section key={entry.room.id} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md, 10px)', padding: '1rem', display: 'grid', gap: '0.6rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 'var(--text-lg, 1.1rem)' }}>{entry.room.name}</h2>
              <p style={{ margin: '0.2rem 0 0', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm, 0.875rem)' }}>
                {polygonAreaM2(entry.room.geometry.vertices).toFixed(1)} m² · {entry.planCount}{' '}
                {entry.planCount === 1 ? 'layout' : 'layouts'} · last worked on {entry.lastEditedAt.toLocaleDateString('en-GB')}
              </p>
            </div>
            {/* Measure once, lay out many times - so a room's own link opens it
                with a fresh layout rather than reopening the last one. */}
            <Link href={`/space-planner?room=${entry.room.id}`} prefetch={false} style={{ color: 'var(--color-primary)', fontSize: 'var(--text-sm, 0.875rem)' }}>
              New layout in this room →
            </Link>
          </div>

          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.35rem' }}>
            {plans.map((plan) => (
              <li key={plan.id}>
                {/* The whole row opens the layout. A list of things somebody
                    spent an afternoon on that cannot be clicked is a list of
                    things they have effectively lost. */}
                <Link
                  href={`/space-planner?plan=${plan.id}`}
                  prefetch={false}
                  className="spl-space-row"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                    padding: '0.5rem 0.6rem',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm, 6px)',
                    color: 'inherit',
                    textDecoration: 'none',
                  }}
                >
                  <span>{plan.name}</span>
                  <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm, 0.875rem)' }}>
                    {plan.items.items.filter((item) => !item.staged).length} items
                    {plan.quoteId && ' · quoted'}
                    {plan.shareToken && ' · shared'}
                    {' · open →'}
                  </span>
                </Link>
              </li>
            ))}
            {plans.length === 0 && (
              <li style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm, 0.875rem)' }}>
                No layouts in this one yet.{' '}
                <Link href={`/space-planner?room=${entry.room.id}`} prefetch={false} style={{ color: 'var(--color-primary)' }}>
                  Start one
                </Link>
                .
              </li>
            )}
          </ul>
        </section>
      ))}
    </div>
  )
}
