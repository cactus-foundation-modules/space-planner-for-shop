'use client'

import { useEffect, useState } from 'react'
import type { SplConfig } from '@/modules/space-planner-for-shop/lib/config'

// The module's settings, hosted inside Shop settings (manifest settingsTabs >
// host: shop.settings-sub-tabs) rather than on a core settings page - module
// settings belong to the module.

export function SpacePlannerSettingsPanel() {
  const [config, setConfig] = useState<SplConfig | null>(null)
  const [renderWorker, setRenderWorker] = useState(false)
  const [deliveryAvailable, setDeliveryAvailable] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    void (async () => {
      const response = await fetch('/api/m/space-planner-for-shop/admin/settings')
      if (!response.ok) return
      const data = (await response.json()) as { config: SplConfig; renderWorkerConfigured: boolean; deliveryEstimatesAvailable: boolean }
      setConfig(data.config)
      setRenderWorker(data.renderWorkerConfigured)
      setDeliveryAvailable(data.deliveryEstimatesAvailable)
    })()
  }, [])

  if (!config) return <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>

  const patch = (fields: Partial<SplConfig>) => setConfig({ ...config, ...fields })

  const save = async () => {
    setStatus('Saving…')
    const response = await fetch('/api/m/space-planner-for-shop/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    setStatus(response.ok ? 'Saved.' : 'That did not save. Try again.')
  }

  return (
    <div style={{ display: 'grid', gap: '1.25rem', maxWidth: '44rem' }}>
      <section style={{ display: 'grid', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>Where it shows up</h3>
        <Toggle label="Button on the basket page" checked={config.showOnCart} onChange={(value) => patch({ showOnCart: value })} />
        <Text label="Basket button wording" value={config.cartButtonLabel} onChange={(value) => patch({ cartButtonLabel: value })} />
        <Toggle label="Button on product pages" checked={config.showOnProduct} onChange={(value) => patch({ showOnProduct: value })} />
        <Text label="Product button wording" value={config.productButtonLabel} onChange={(value) => patch({ productButtonLabel: value })} />
      </section>

      <section style={{ display: 'grid', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>What customers can do with a plan</h3>
        <Toggle label="Ask for a quote" checked={config.quoteEnabled} onChange={(value) => patch({ quoteEnabled: value })} />
        <Toggle label="Email themselves the plan" checked={config.emailPlanEnabled} onChange={(value) => patch({ emailPlanEnabled: value })} />
        <Toggle
          label={`Photoreal pictures${renderWorker ? '' : ' (the picture service is not set up on this site yet)'}`}
          checked={config.rendersEnabled}
          onChange={(value) => patch({ rendersEnabled: value })}
        />
        <Toggle
          label={`Show delivery dates on the item list${deliveryAvailable ? '' : ' (this shop cannot work them out yet)'}`}
          checked={config.deliveryColumnEnabled}
          onChange={(value) => patch({ deliveryColumnEnabled: value })}
        />
        <Toggle
          label="Let customers download the 3D models in their plan"
          checked={config.glbExportEnabled}
          onChange={(value) => patch({ glbExportEnabled: value })}
        />
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
          Off by default. With it on, anyone can save your suppliers&apos; 3D models to their own computer. The floor plan, the
          item list and the pictures all work either way.
        </p>
      </section>

      <section style={{ display: 'grid', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>Spacing guidance</h3>
        <Toggle label="Warn about tight walkways" checked={config.clearanceWarningsEnabled} onChange={(value) => patch({ clearanceWarningsEnabled: value })} />
        <NumberField label="Walkway (mm)" value={config.walkwayClearanceMm} onChange={(value) => patch({ walkwayClearanceMm: value })} />
        <NumberField label="Room behind a desk for a chair (mm)" value={config.deskChairClearanceMm} onChange={(value) => patch({ deskChairClearanceMm: value })} />
        <Textarea label="Wording shown with every warning and on every printout" value={config.guidanceDisclaimer} onChange={(value) => patch({ guidanceDisclaimer: value })} />
      </section>

      <section style={{ display: 'grid', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>Limits</h3>
        <NumberField label="Spaces per customer" value={config.maxRoomsPerMember} onChange={(value) => patch({ maxRoomsPerMember: value })} />
        <NumberField label="Layouts per space" value={config.maxPlansPerRoom} onChange={(value) => patch({ maxPlansPerRoom: value })} />
        <NumberField label="Things in one layout" value={config.maxItemsPerPlan} onChange={(value) => patch({ maxItemsPerPlan: value })} />
        <NumberField label="Different 3D models on screen at once" value={config.maxUniqueModels} onChange={(value) => patch({ maxUniqueModels: value })} />
      </section>

      <section style={{ display: 'grid', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>Housekeeping</h3>
        <NumberField label="Flag spaces untouched for this many months" value={config.roomIdleFlagMonths} onChange={(value) => patch({ roomIdleFlagMonths: value })} />
        <NumberField label="Keep usage counts for this many days" value={config.eventRetentionDays} onChange={(value) => patch({ eventRetentionDays: value })} />
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
          Idle spaces are only flagged, never deleted - somebody spent an afternoon on those.
        </p>
      </section>

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" onClick={() => void save()}>Save settings</button>
        {status && <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>{status}</span>}
      </div>
    </div>
  )
}

function Toggle(props: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
    </label>
  )
}

function Text(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label style={{ display: 'grid', gap: '0.25rem' }}>
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{props.label}</span>
      <input className="form-input" value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  )
}

function Textarea(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label style={{ display: 'grid', gap: '0.25rem' }}>
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{props.label}</span>
      <textarea className="form-input" rows={3} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  )
}

function NumberField(props: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label style={{ display: 'grid', gap: '0.25rem' }}>
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{props.label}</span>
      <input
        className="form-input"
        type="number"
        value={props.value}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) props.onChange(value)
        }}
      />
    </label>
  )
}
