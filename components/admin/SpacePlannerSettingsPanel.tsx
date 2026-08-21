'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { SplConfig } from '@/modules/space-planner-for-shop/lib/config'

// The module's settings, hosted inside Shop settings (manifest settingsTabs >
// host: shop.settings-sub-tabs) rather than on a core settings page - module
// settings belong to the module.

export function SpacePlannerSettingsPanel() {
  const [config, setConfig] = useState<SplConfig | null>(null)
  const [renderWorker, setRenderWorker] = useState(false)
  const [deliveryAvailable, setDeliveryAvailable] = useState(false)
  const [quoteRequests, setQuoteRequests] = useState(false)
  const [status, setStatus] = useState('')
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/m/space-planner-for-shop/admin/settings')
        if (!response.ok) throw new Error()
        const data = (await response.json()) as {
          config: SplConfig
          renderWorkerConfigured: boolean
          deliveryEstimatesAvailable: boolean
          quoteRequestsAvailable: boolean
        }
        if (!mounted.current) return
        setConfig(data.config)
        setRenderWorker(data.renderWorkerConfigured)
        setDeliveryAvailable(data.deliveryEstimatesAvailable)
        setQuoteRequests(data.quoteRequestsAvailable)
      } catch {
        // "Loading…" for ever is a lie with a spinner. Say it failed.
        if (mounted.current) setFailed(true)
      }
    })()
  }, [])

  if (failed) return <p style={{ color: 'var(--color-danger)' }}>The settings would not load. Check the connection and refresh the page.</p>
  if (!config) return <p style={{ color: 'var(--color-text-secondary)' }}>Loading…</p>

  const patch = (fields: Partial<SplConfig>) => setConfig({ ...config, ...fields })

  const save = async () => {
    // One save at a time: two in flight can land out of order, and the stale
    // one wins whichever the owner pressed last.
    if (saving) return
    setSaving(true)
    setStatus('Saving…')
    try {
      const response = await fetch('/api/m/space-planner-for-shop/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (response.ok) {
        if (mounted.current) setStatus('Saved.')
      } else if (response.status === 403) {
        // The panel opens for anyone who can see Space Planner, so a refusal
        // here is about the account rather than about anything typed into it.
        if (mounted.current) setStatus('Your account can look but not change these settings - that needs the Space Planner manage permission.')
      } else {
        const data = (await response.json().catch(() => null)) as { error?: string } | null
        if (mounted.current) setStatus(data?.error ?? 'That did not save. Try again.')
      }
    } catch {
      if (mounted.current) setStatus('That did not save. Check the connection and try again.')
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: '1.25rem', maxWidth: '44rem' }}>
      <section style={{ display: 'grid', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>Who can see it</h3>
        <Toggle
          label="Hide the Space Planner from customers (staff only)"
          checked={config.adminOnly}
          onChange={(value) => patch({ adminOnly: value })}
        />
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          On, and the planner vanishes from your shop entirely - no buttons, no links, and its own address says the page does
          not exist. Anyone signed in to this admin with Space Planner access carries on using it as normal, so you can live
          with it on your real catalogue before anybody else meets it. Layouts you have already shared by link keep working, since
          you sent those to somebody on purpose. Saving a layout still needs a customer account, staff or not.
        </p>
      </section>

      <section style={{ display: 'grid', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>Where it shows up</h3>
        {config.adminOnly && (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
            None of this reaches customers while the planner is staff only.
          </p>
        )}
        <Toggle label="Button on the basket page" checked={config.showOnCart} onChange={(value) => patch({ showOnCart: value })} />
        <Text label="Basket button wording" value={config.cartButtonLabel} onChange={(value) => patch({ cartButtonLabel: value })} />
        <Toggle label="Button on product pages" checked={config.showOnProduct} onChange={(value) => patch({ showOnProduct: value })} />
        <Text label="Product button wording" value={config.productButtonLabel} onChange={(value) => patch({ productButtonLabel: value })} />
      </section>

      <section style={{ display: 'grid', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>What customers can do with a layout</h3>
        <Toggle
          label={`Ask for a quote${quoteRequests ? '' : ' (this shop is not set to sell by quote, so nothing is offered)'}`}
          checked={config.quoteEnabled}
          onChange={(value) => patch({ quoteEnabled: value })}
        />
        {!quoteRequests && (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
            Shop &gt; Quotes is set to a normal shop with checkout, so no part of the shop invites a quote request and the
            planner does not either. Switch that to quotes-only and this comes back on its own.
          </p>
        )}
        <Toggle label="Email themselves the layout" checked={config.emailPlanEnabled} onChange={(value) => patch({ emailPlanEnabled: value })} />
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
      </section>

      <section style={{ display: 'grid', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>Spacing guidance</h3>
        <Toggle label="Warn about tight walkways" checked={config.clearanceWarningsEnabled} onChange={(value) => patch({ clearanceWarningsEnabled: value })} />
        <NumberField label="Walkway (mm)" value={config.walkwayClearanceMm} min={0} max={5000} onChange={(value) => patch({ walkwayClearanceMm: value })} />
        <NumberField label="Space behind a desk for a chair (mm)" value={config.deskChairClearanceMm} min={0} max={5000} onChange={(value) => patch({ deskChairClearanceMm: value })} />
        <Textarea label="Wording shown with every warning and on every printout" value={config.guidanceDisclaimer} onChange={(value) => patch({ guidanceDisclaimer: value })} />
      </section>

      <section style={{ display: 'grid', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>Limits</h3>
        <NumberField label="Spaces per customer" value={config.maxRoomsPerMember} min={1} max={500} onChange={(value) => patch({ maxRoomsPerMember: value })} />
        <NumberField label="Layouts per space" value={config.maxPlansPerRoom} min={1} max={200} onChange={(value) => patch({ maxPlansPerRoom: value })} />
        <NumberField label="Things in one layout" value={config.maxItemsPerPlan} min={10} max={400} onChange={(value) => patch({ maxItemsPerPlan: value })} />
        <NumberField label="Different 3D models on screen at once" value={config.maxUniqueModels} min={2} max={64} onChange={(value) => patch({ maxUniqueModels: value })} />
      </section>

      <section style={{ display: 'grid', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>Housekeeping</h3>
        <NumberField label="Keep usage counts for this many days" value={config.eventRetentionDays} min={0} max={3650} onChange={(value) => patch({ eventRetentionDays: value })} />
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          Nothing a customer saved is ever deleted by this - somebody spent an afternoon on those.
        </p>
      </section>

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {status && <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }} role="status">{status}</span>}
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
  const id = useId()
  return (
    <div className="field" style={{ margin: 0 }}>
      <label htmlFor={id}>{props.label}</label>
      <input id={id} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </div>
  )
}

function Textarea(props: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId()
  return (
    <div className="field" style={{ margin: 0 }}>
      <label htmlFor={id}>{props.label}</label>
      <textarea id={id} rows={3} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </div>
  )
}

/**
 * A number the owner can actually type.
 *
 * The floor used to be enforced on every keystroke against the CONTROLLED
 * value, which makes some numbers unreachable: selecting "200" and typing
 * "150" starts with "1", which is under a minimum of 10, so the change was
 * rejected and the box snapped straight back to 200. With a minimum of 2 no
 * number beginning with 1 could be typed at all. Clearing the box was worse
 * where the floor is zero - `Number('')` is 0, so emptying "keep usage counts
 * for this many days" silently set it to nought, which the sweep reads as
 * "keep for ever": the exact opposite of what the label says.
 *
 * So the box holds text while it is being typed, and the floor is applied when
 * the owner leaves it. The server still enforces the same range, and now says
 * so in the hint rather than only in a rejection.
 */
function NumberField(props: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number }) {
  const min = props.min ?? 0
  const max = props.max
  const id = useId()
  // Null while nobody is typing, so the box simply shows the saved value and
  // there is no effect syncing one piece of state to another.
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(props.value)

  const settle = () => {
    const value = Number(text)
    setDraft(null)
    if (!Number.isFinite(value) || text.trim() === '') return
    const whole = Math.round(Math.max(min, max === undefined ? value : Math.min(max, value)))
    if (whole !== props.value) props.onChange(whole)
  }

  return (
    <div className="field" style={{ margin: 0 }}>
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        type="number"
        min={min}
        {...(max === undefined ? {} : { max })}
        value={text}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={settle}
        aria-describedby={`${id}-range`}
      />
      <p id={`${id}-range`} className="field-hint" style={{ color: 'var(--color-text-secondary)' }}>
        {max === undefined ? `${min} or more` : `Between ${min} and ${max}`}
      </p>
    </div>
  )
}
