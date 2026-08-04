import { getSessionFromCookie } from '@/lib/auth/session'
import { hasSplPermission } from '@/modules/space-planner-for-shop/lib/access'
import { RendersScreen } from '@/modules/space-planner-for-shop/components/admin/RendersScreen'

export const metadata = { title: 'Pictures — Admin' }

export default async function SpacePlannerRendersScreenPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const canAccess = await hasSplPermission(user, 'space-planner.access', { allowAccess: true })
  if (!canAccess) return <div className="alert alert-danger">You do not have permission to view the Space Planner.</div>
  return <RendersScreen />
}
