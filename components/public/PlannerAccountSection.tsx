import Link from 'next/link'
import { getMemberFromCookie } from '@/lib/members/session'
import { listRoomsForMember } from '@/modules/space-planner-for-shop/lib/db/rooms'
import { plannerVisible } from '@/modules/space-planner-for-shop/lib/visibility'

// The planner's card on the member account overview (core's
// members.account-section point).
//
// It earns its place by answering the question somebody opens their account to
// ask - where did I get to with that room - rather than by being a link to a
// page they already know about. A member with nothing saved sees nothing at all;
// the planner's own page is where they should be, and it is in the nav.
export async function PlannerAccountSection() {
  const member = await getMemberFromCookie()
  if (!member) return null
  if (!(await plannerVisible())) return null

  const rooms = await listRoomsForMember(member.id)
  if (rooms.length === 0) return null

  const latest = rooms[0]
  const totalPlans = rooms.reduce((sum, entry) => sum + entry.planCount, 0)

  return (
    <div className="card" style={{ padding: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
        <h2 className="card-title" style={{ margin: 0 }}>Your spaces</h2>
        <Link
          href="/space-planner/spaces"
          prefetch={false}
          style={{ color: 'var(--color-primary)', fontSize: 'var(--text-sm)', textDecoration: 'none' }}
        >
          See all →
        </Link>
      </div>

      <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
        {rooms.length === 1 ? 'One space' : `${rooms.length} spaces`}, {totalPlans === 1 ? 'one layout' : `${totalPlans} layouts`}.
        {latest && ` Last worked on: ${latest.room.name}.`}
      </p>
    </div>
  )
}
