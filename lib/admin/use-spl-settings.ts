'use client'

import { useEffect, useRef, useState } from 'react'
import type { SplConfig } from '@/modules/space-planner-for-shop/lib/config'

// Loading the module's settings, split out from the panel that edits them.
//
// The Space Planner admin is one tab inside Shop settings, and the tab strip has
// to be drawn before anybody clicks Settings - so whether this account may even
// read the settings has to be known up front, not discovered when the form
// mounts. That is the whole reason this is a hook rather than a fetch inside the
// form: a 403 here removes the Settings tab, it does not put an error inside it.

/** What the settings endpoint answers with. */
export type SplSettingsPayload = {
  config: SplConfig
  /** Whether the picture service is actually wired up on this site. */
  renderWorkerConfigured: boolean
  /** Whether this shop can work out delivery dates at all. */
  deliveryEstimatesAvailable: boolean
  /** Whether the shop invites quote requests in the first place. */
  quoteRequestsAvailable: boolean
}

export type SplSettingsLoad =
  | { state: 'loading' }
  | { state: 'ready'; payload: SplSettingsPayload }
  /** This account may see the Space Planner but not its settings. */
  | { state: 'forbidden' }
  | { state: 'failed' }

export function useSplSettings(): SplSettingsLoad {
  const [load, setLoad] = useState<SplSettingsLoad>({ state: 'loading' })
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void (async () => {
      try {
        // no-store: a reload straight after saving must not be answered from the
        // browser's cache with the pre-save values, which reads as "it didn't save".
        const response = await fetch('/api/m/space-planner-for-shop/admin/settings', { cache: 'no-store' })
        if (response.status === 403) {
          if (mounted.current) setLoad({ state: 'forbidden' })
          return
        }
        if (!response.ok) throw new Error('settings request failed')
        const payload = (await response.json()) as SplSettingsPayload
        if (mounted.current) setLoad({ state: 'ready', payload })
      } catch {
        // "Loading…" for ever is a lie with a spinner. Say it failed.
        if (mounted.current) setLoad({ state: 'failed' })
      }
    })()
    return () => {
      mounted.current = false
    }
  }, [])

  return load
}
