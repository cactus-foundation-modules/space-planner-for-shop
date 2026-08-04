import { getMembersConfig } from '@/lib/members/config'
import type { MemberAccountNavItem } from '@/lib/members/account-nav'
import { prisma } from '@/lib/db/prisma'
import { plannerVisible } from '@/modules/space-planner-for-shop/lib/visibility'

// The planner's tab in the member account nav (core's members.account-nav point).
//
// "My spaces" rather than "My plans", because a room is the thing a person
// remembers measuring and a plan is one of several attempts at filling it.
//
// Nothing is contributed when the member has never saved anything: a tab leading
// to an empty list is worse than no tab, and the planner's own page is where
// somebody with no rooms should be sent anyway.
export async function spacePlannerMemberAccountNav(member: { id: string }): Promise<MemberAccountNavItem[]> {
  const membersConfig = await getMembersConfig()
  if (!membersConfig.enabled) return []
  if (!(await plannerVisible())) return []

  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "spl_rooms" WHERE "member_id" = ${member.id}
  `
  const count = Number(rows[0]?.count ?? 0)
  if (count === 0) return []

  return [{ key: 'space-planner', label: 'My spaces', href: '/space-planner/spaces', badge: 0 }]
}
