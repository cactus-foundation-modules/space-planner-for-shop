import { plannerVisible } from '@/modules/space-planner-for-shop/lib/visibility'

// Answers core's "core.member-notification-category-visible" point for this
// module's own notification categories. With the planner set to staff-only a
// customer cannot use it, so the account page must not offer them a choice
// about render emails from it either. Same gate as every other storefront
// surface (plannerVisible), so the two can never disagree.

export async function splNotificationCategoryVisible(category: string): Promise<boolean> {
  if (!category.startsWith('space-planner.')) return true
  return plannerVisible()
}
