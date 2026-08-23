import { notFound } from 'next/navigation'
import { getMemberFromCookie } from '@/lib/members/session'
import MemberAccountShell from '@/components/members/account/MemberAccountShell'
import { plannerVisible } from '@/modules/space-planner-for-shop/lib/visibility'
import { PlannerSpacesSection } from '@/modules/space-planner-for-shop/components/public/PlannerSpacesSection'

export const metadata = { title: 'My spaces' }

// The spaces page. Everything on it lives in PlannerSpacesSection, which is the
// same component core draws into a one-page member account - so the two shapes
// cannot drift apart.
//
// Wrapped in core's account shell when there is a member to wrap it for: this is
// a tab of somebody's account, and left bare it was a page with no tabs and no
// way back. A signed-out visitor gets the plain frame and the section's own
// "sign in" prompt.
export default async function SpacesPage() {
  if (!(await plannerVisible())) notFound()

  const member = await getMemberFromCookie()
  if (!member) {
    return (
      <div style={{ maxWidth: '40rem', margin: '0 auto', padding: '3rem 1.5rem' }}>
        <PlannerSpacesSection />
      </div>
    )
  }

  return (
    <MemberAccountShell member={member}>
      <PlannerSpacesSection />
    </MemberAccountShell>
  )
}
