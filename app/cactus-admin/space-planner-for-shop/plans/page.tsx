import { getSessionFromCookie } from '@/lib/auth/session'
import { hasSplPermission } from '@/modules/space-planner-for-shop/lib/access'
import SpacePlannerNav from '@/modules/space-planner-for-shop/components/admin/SpacePlannerNav'
import { PlansScreen } from '@/modules/space-planner-for-shop/components/admin/PlansScreen'

export const metadata = { title: 'Spaces & layouts — Admin' }

export default async function SpacePlannerPlansScreenPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const canAccess = await hasSplPermission(user, 'space-planner.access', { allowAccess: true })
  if (!canAccess) return <div className="alert alert-danger">You do not have permission to view the Space Planner.</div>
  return (
    <div>
      <SpacePlannerNav />
      <PlansScreen />
    </div>
  )
}
