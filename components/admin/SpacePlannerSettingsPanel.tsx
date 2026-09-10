'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { TabStrip } from '@/components/admin/TabStrip'
import { useSplSettings } from '@/modules/space-planner-for-shop/lib/admin/use-spl-settings'
import { SpacePlannerSettingsForm } from '@/modules/space-planner-for-shop/components/admin/SpacePlannerSettingsForm'

// The whole Space Planner admin, as one tab inside Shop settings (manifest
// settingsTabs > host: shop.settings-sub-tabs).
//
// It used to be a sidebar link of its own with these screens as tabs on the page,
// which made it the only shop add-on on the rail - every other one lives under
// Settings > Shop. So the link went and the screens came here, behind the same
// tab strip they always had, with the module's own settings joining them.
//
// The four screens are loaded on demand rather than imported outright: Sizes
// alone pulls the 3D stack in to measure models in the browser, and Shop settings
// is opened far more often to change a delivery charge than to rebuild a
// catalogue's dimensions. ssr:false because every one of them is a browser screen
// that fetches its own data - there is nothing for the server to render.
const PlansScreen = dynamic(() => import('@/modules/space-planner-for-shop/components/admin/PlansScreen').then((m) => m.PlansScreen), { ssr: false, loading: Loading })
const ModelsScreen = dynamic(() => import('@/modules/space-planner-for-shop/components/admin/ModelsScreen').then((m) => m.ModelsScreen), { ssr: false, loading: Loading })
const DimensionsScreen = dynamic(() => import('@/modules/space-planner-for-shop/components/admin/DimensionsScreen').then((m) => m.DimensionsScreen), { ssr: false, loading: Loading })
const RendersScreen = dynamic(() => import('@/modules/space-planner-for-shop/components/admin/RendersScreen').then((m) => m.RendersScreen), { ssr: false, loading: Loading })

function Loading() {
  return <p style={{ color: 'var(--color-text-secondary)' }}>Loading…</p>
}

/** Which tab is open rides in the query string under this key, so a refresh comes
 *  back to it. Not `sub`: that one is Shop's, naming which of its sub-tabs is open,
 *  and this sits inside one of them. */
const TAB_PARAM = 'spl'

type TabKey = 'settings' | 'plans' | 'models' | 'dimensions' | 'renders'

const SCREEN_TABS: { key: TabKey; label: string }[] = [
  { key: 'plans', label: 'Spaces & layouts' },
  { key: 'models', label: 'Model corrections' },
  { key: 'dimensions', label: 'Sizes' },
  { key: 'renders', label: 'Pictures' },
]

export function SpacePlannerSettingsPanel() {
  const load = useSplSettings()
  // Settings is the first tab for whoever may change them, and simply absent for
  // an account that may only look - space-planner.access opens this panel, but the
  // settings endpoint itself answers to space-planner.manage. Rather than offer a
  // tab that can only ever say "not for you", the strip drops it.
  const settingsOffered = load.state !== 'forbidden'
  const tabs = settingsOffered ? [{ key: 'settings' as TabKey, label: 'Settings' }, ...SCREEN_TABS] : SCREEN_TABS
  const fallback: TabKey = settingsOffered ? 'settings' : 'plans'

  const [tab, setTab] = useState<TabKey>(fallback)

  // Read the URL once on mount, not during a render: the core settings page
  // renders this on the server too, and reading the location mid-render would have
  // the two disagree.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get(TAB_PARAM)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the URL's tab on mount
    if (wanted && SCREEN_TABS.some((t) => t.key === wanted)) setTab(wanted as TabKey)
  }, [])

  // The permission answer lands after the first render, so an account that may not
  // see Settings would flash it. Derived rather than corrected in an effect: the
  // tab it should be showing is a fact about the current render, not a change to
  // make afterwards.
  const active: TabKey = !settingsOffered && tab === 'settings' ? 'plans' : tab

  // replaceState rather than a router navigation: this is bookkeeping about where
  // you already are, so the back button should leave Settings rather than walk back
  // through every tab that got poked at.
  const select = (next: TabKey) => {
    setTab(next)
    const url = new URL(window.location.href)
    if (next === fallback) url.searchParams.delete(TAB_PARAM)
    else url.searchParams.set(TAB_PARAM, next)
    if (url.href !== window.location.href) window.history.replaceState(null, '', url)
  }

  return (
    <div>
      <TabStrip
        style={{ marginBottom: '1.5rem' }}
        items={tabs.map((t) => ({ key: t.key, label: t.label, active: active === t.key, onClick: () => select(t.key) }))}
      />
      {active === 'settings' && <SettingsTabBody load={load} />}
      {active === 'plans' && <PlansScreen />}
      {active === 'models' && <ModelsScreen />}
      {active === 'dimensions' && <DimensionsScreen />}
      {active === 'renders' && <RendersScreen />}
    </div>
  )
}

function SettingsTabBody({ load }: { load: ReturnType<typeof useSplSettings> }) {
  if (load.state === 'failed') return <p style={{ color: 'var(--color-danger)' }}>The settings would not load. Check the connection and refresh the page.</p>
  if (load.state !== 'ready') return <Loading />
  return <SpacePlannerSettingsForm payload={load.payload} />
}
