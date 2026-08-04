import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasSplPermission } from '@/modules/space-planner-for-shop/lib/access'
import { getSplConfigCached } from '@/modules/space-planner-for-shop/lib/config'

// The storefront-side gate for the whole feature (config.adminOnly).
//
// Modelled on shop's getShopGate, including the bit that matters most: the
// session cookie is only read on the restricted path. With the planner public
// this stays cookie-free, so it can never be the thing that drags a cached page
// into being rendered per-request.
//
// "Staff" means an admin session carrying space-planner.access or
// space-planner.manage - the same two keys that open the module's admin screens,
// and a protected role short-circuits both. A member account is a customer, not
// staff, however long they have been buying: the point of this switch is that
// customers cannot get in.
//
// An admin using the planner still needs a member account to SAVE anything -
// rooms and plans belong to a member, exactly as they always have. Drawing a
// room, filling it and reading it back on screen needs nothing but the switch.

export async function plannerVisible(): Promise<boolean> {
  const config = await getSplConfigCached()
  if (!config.adminOnly) return true

  const user = await getSessionFromCookie()
  if (!user) return false
  return hasSplPermission(user, 'space-planner.access', { allowAccess: true })
}

/**
 * API counterpart:
 *   const hidden = await plannerHiddenResponse(); if (hidden) return hidden
 *
 * 404 rather than 403 on purpose. A hidden feature that answers "forbidden"
 * has told a stranger it exists and that there is something worth having.
 */
export async function plannerHiddenResponse(): Promise<NextResponse | null> {
  if (await plannerVisible()) return null
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
