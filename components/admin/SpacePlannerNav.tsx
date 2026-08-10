'use client'

import { usePathname } from 'next/navigation'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { TabStrip } from '@/components/admin/TabStrip'

// The Space Planner admin is one sidebar link with these four surfaces as tabs on
// the page, rather than four links of its own on the rail.
const TABS = [
  { label: 'Spaces & layouts', segment: 'plans' },
  { label: 'Model corrections', segment: 'models' },
  { label: 'Sizes', segment: 'dimensions' },
  { label: 'Pictures', segment: 'renders' },
]

export default function SpacePlannerNav() {
  const pathname = usePathname()
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/space-planner-for-shop`

  return (
    <TabStrip
      style={{ marginBottom: '1.5rem' }}
      items={TABS.map((tab) => {
        const href = `${base}/${tab.segment}`
        return { key: tab.segment, label: tab.label, href, active: !!pathname?.startsWith(href) }
      })}
    />
  )
}
