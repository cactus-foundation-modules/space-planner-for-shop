import { headers } from 'next/headers'
import { getEventSummary, listMostPlacedWithoutModel } from '@/modules/space-planner-for-shop/lib/db/events'

// The planner's tile on the admin dashboard (core.admin-dashboard-widgets).
//
// Three numbers and one sentence. The sentence is the point: "what should we get
// 3D-modelled next" is the question this module is uniquely able to answer, and
// it answers it in demand order rather than as a hunch.
export async function spacePlannerDashboardWidget() {
  const [summary, wanted] = await Promise.all([getEventSummary(), listMostPlacedWithoutModel(3)])
  const adminPath = (await headers()).get('x-cactus-admin-path') ?? ''

  return (
    <div className="card" style={{ padding: '1.25rem' }}>
      <h2 className="card-title" style={{ margin: '0 0 0.75rem' }}>Space Planner</h2>
      <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{summary.openedThisWeek}</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>Opened this week</div>
        </div>
        <div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{summary.plansThisWeek}</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>Layouts saved</div>
        </div>
        <div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{summary.quotesThisWeek}</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>Quotes asked for</div>
        </div>
      </div>

      {wanted.length > 0 && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', margin: '0 0 0.75rem' }}>
          Most placed without a 3D model: {wanted.map((entry) => entry.name).join(', ')}.
        </p>
      )}

      <a href={`/${adminPath}/m/space-planner-for-shop/plans`} style={{ fontSize: 'var(--text-sm)', color: 'var(--color-primary)', textDecoration: 'none' }}>
        Rooms &amp; plans →
      </a>
    </div>
  )
}
