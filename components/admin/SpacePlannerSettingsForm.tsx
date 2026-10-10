'use client'

import { useId, useRef, useState, useEffect } from 'react'
import type { SplConfig } from '@/modules/space-planner-for-shop/lib/config'
import type { SplSettingsPayload } from '@/modules/space-planner-for-shop/lib/admin/use-spl-settings'
import { SettingsHeaderActions, SettingsHeaderStatus } from '@/components/admin/SettingsHeaderActions'
import { InfoTip } from '@/components/admin/InfoTip'

// The module's settings form. It sits on the Settings tab of the Space Planner
// panel inside Shop settings (manifest settingsTabs > host: shop.settings-sub-tabs)
// rather than on a core settings page - module settings belong to the module.
//
// Loading is the panel's job (lib/admin/use-spl-settings), because the tab strip
// has to know whether this account may see settings at all before it draws itself.
// By the time this renders the answer is yes and the values are in hand, so this
// file only edits and saves them.

export function SpacePlannerSettingsForm({ payload }: { payload: SplSettingsPayload }) {
  const [config, setConfig] = useState<SplConfig>(payload.config)
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const renderWorker = payload.renderWorkerConfigured
  const deliveryAvailable = payload.deliveryEstimatesAvailable
  const quoteRequests = payload.quoteRequestsAvailable

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
    <div className="settings-masonry">
      <section className="card">
        <div className="card-title">
          Who sees it, and where
          {config.adminOnly && <InfoTip>None of the buttons reach customers while the planner is staff only.</InfoTip>}
        </div>
        <Toggle
          label="Hide the Space Planner from customers (staff only)"
          checked={config.adminOnly}
          onChange={(value) => patch({ adminOnly: value })}
          tip="The planner disappears from your shop and its address says the page does not exist. Staff with Space Planner access can still use it, and layouts already shared by link keep working."
        />
        <Toggle label="Email themselves the layout" checked={config.emailPlanEnabled} onChange={(value) => patch({ emailPlanEnabled: value })} />
        <Toggle label="Button on the basket page" checked={config.showOnCart} onChange={(value) => patch({ showOnCart: value })} />
        <Toggle label="Button on product pages" checked={config.showOnProduct} onChange={(value) => patch({ showOnProduct: value })} />
        <Text label="Basket button wording" value={config.cartButtonLabel} onChange={(value) => patch({ cartButtonLabel: value })} />
        <Text label="Product button wording" value={config.productButtonLabel} onChange={(value) => patch({ productButtonLabel: value })} />
        <Toggle
          label={`Customers can ask for a quote${quoteRequests ? '' : ' (not offered: this shop does not sell by quote)'}`}
          checked={config.quoteEnabled}
          onChange={(value) => patch({ quoteEnabled: value })}
          tip={quoteRequests ? undefined : 'Shop > Quotes is set to a normal shop with checkout, so no part of the shop invites a quote request and the planner does not either. Switch that to quotes-only and this comes back on its own.'}
        />
        <Toggle
          label={`Photoreal pictures${renderWorker ? '' : ' (the picture service is not set up yet)'}`}
          checked={config.rendersEnabled}
          onChange={(value) => patch({ rendersEnabled: value })}
        />
        <Toggle
          label={`Show delivery dates on the item list${deliveryAvailable ? '' : ' (this shop cannot work them out yet)'}`}
          checked={config.deliveryColumnEnabled}
          onChange={(value) => patch({ deliveryColumnEnabled: value })}
        />
      </section>

      <section className="card">
        <div className="card-title">Spacing guidance</div>
        <Toggle label="Warn about tight walkways" checked={config.clearanceWarningsEnabled} onChange={(value) => patch({ clearanceWarningsEnabled: value })} wide />
        <NumberField label="Walkway (mm)" value={config.walkwayClearanceMm} min={0} max={5000} onChange={(value) => patch({ walkwayClearanceMm: value })} />
        <NumberField label="Space behind a desk for a chair (mm)" value={config.deskChairClearanceMm} min={0} max={5000} onChange={(value) => patch({ deskChairClearanceMm: value })} />
        <Textarea label="Wording shown with every warning and on every printout" value={config.guidanceDisclaimer} onChange={(value) => patch({ guidanceDisclaimer: value })} />
      </section>

      <section className="card">
        <div className="card-title">
          Limits and housekeeping
          <InfoTip>Old usage counts are cleared after the number of days set here. Nothing a customer saved is ever deleted by it - somebody spent an afternoon on those.</InfoTip>
        </div>
        <NumberField label="Spaces per customer" value={config.maxRoomsPerMember} min={1} max={500} onChange={(value) => patch({ maxRoomsPerMember: value })} />
        <NumberField label="Layouts per space" value={config.maxPlansPerRoom} min={1} max={200} onChange={(value) => patch({ maxPlansPerRoom: value })} />
        <NumberField label="Things in one layout" value={config.maxItemsPerPlan} min={10} max={400} onChange={(value) => patch({ maxItemsPerPlan: value })} />
        <NumberField label="Different 3D models on screen at once" value={config.maxUniqueModels} min={2} max={64} onChange={(value) => patch({ maxUniqueModels: value })} />
        <NumberField label="Keep usage counts for this many days" value={config.eventRetentionDays} min={0} max={3650} onChange={(value) => patch({ eventRetentionDays: value })} />
      </section>

      <SettingsHeaderActions>
        <SettingsHeaderStatus
          message={status === 'Saved.' ? status : null}
          error={status && status !== 'Saved.' && status !== 'Saving…' ? status : null}
        />
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </SettingsHeaderActions>
    </div>
  )
}

function Toggle(props: { label: string; checked: boolean; onChange: (value: boolean) => void; tip?: string; wide?: boolean }) {
  return (
    <label className={props.wide ? 'settings-check field--wide' : 'settings-check'}>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
      {props.tip && <InfoTip>{props.tip}</InfoTip>}
    </label>
  )
}

function Text(props: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input id={id} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </div>
  )
}

function Textarea(props: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId()
  return (
    <div className="field">
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
    <div className="field">
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
