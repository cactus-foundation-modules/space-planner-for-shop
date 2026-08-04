import { getSessionFromCookie, type SessionUser } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'

// Permission gate for this module's admin surfaces, in the same shape shop's own
// requireShopUser has, so a route reads the same whichever module it belongs to.
//
// Two keys: space-planner.access to look, space-planner.manage to change
// anything. Shop's keys are deliberately not accepted even though the settings
// panel is hosted inside shop's settings page - a member's saved room plans have
// their name on them, and whoever is allowed to edit the catalogue is not
// automatically allowed to read a customer's office layout. An owner who wants
// that grants both keys to the same role, which is a decision rather than an
// accident.

export type SplPermissionKey = 'space-planner.access' | 'space-planner.manage'

export async function hasSplPermission(
  user: SessionUser,
  key: SplPermissionKey,
  opts?: { allowAccess?: boolean },
): Promise<boolean> {
  if (await hasPermission(user, 'space-planner.manage')) return true
  if (opts?.allowAccess && (await hasPermission(user, 'space-planner.access'))) return true
  return hasPermission(user, key)
}

export async function requireSplUser(
  key: SplPermissionKey,
  opts?: { allowAccess?: boolean },
): Promise<{ user: SessionUser; error?: undefined } | { user?: undefined; error: Response }> {
  const user = await getSessionFromCookie()
  if (!user) return { error: errorResponse('Not authenticated', 401) }
  if (!(await hasSplPermission(user, key, opts))) return { error: errorResponse('Forbidden', 403) }
  return { user }
}
