'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  isOptionVisible,
  isValueAvailable,
  resolveVariant,
  withAutoSelected,
} from '@/modules/shop-variations/lib/selection-logic'
import type { OptionSelection } from '@/modules/shop-variations/lib/selection-logic'
import type { VariantSelectorPayload } from '@/modules/shop-variations/lib/types'
import type { ProductInfo } from '@/modules/space-planner-for-shop/lib/client/planner-store'

// Which one of the family goes in the room.
//
// A listing is not a thing you can place. Its size row describes the family - the
// Oslo Oval Boardroom Table listing carries a depth and a height and no width at
// all, so the ladder fills the width from the category default and a 2.4 m table
// arrives in an 800 mm footprint - and its price is a "from". The variation
// carries the real width, the real price and, usually, its own model file.
//
// So: pick, see what you have picked, then place it. The maths is shop-variations'
// own, the same functions its product page uses, so this can never offer a
// combination the shop would not sell. What is deliberately NOT here is the rest
// of that picker: no add-ons, no gallery, no quantity, no cart. Somebody is
// planning a room, not checking out.

export type VariationPickerProps = {
  productId: string
  productName: string
  /** The listing's own picture, shown until the chosen variation has one. */
  image: string | null
  onCancel: () => void
  /** Handed the variation, sized and priced, ready to drop in the room. */
  onPlace: (info: ProductInfo, quantity?: number) => void
  /**
   * There turned out to be nothing to choose from - a family whose options have
   * gone, or a shop mid-edit. The listing goes in exactly as it did before this
   * picker existed, because a card that opens a dead panel is worse than a card
   * that places the wrong size.
   */
  onNothingToChoose: () => void
}

type Loaded = {
  payload: VariantSelectorPayload
  currencySymbol: string
  modelled: Set<string>
}

/** What the products route answers with, narrowed to what this needs. */
type SizedProduct = ProductInfo & { id: string }

export function VariationPicker(props: VariationPickerProps) {
  // Pulled out of props so the load effect can depend on exactly these two and
  // not on "any prop changed", which for a panel that re-renders as the shopper
  // types would mean fetching the option list over and over. The panel keeps
  // both stable - see its useCallback.
  const { productId, onNothingToChoose } = props
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [selection, setSelection] = useState<OptionSelection>({})
  const [error, setError] = useState('')
  // Sizes already looked up, kept by child id rather than as one "current"
  // answer: flicking back to a colour you have already been on should not ask
  // the server about it a second time, and holding them this way is also what
  // keeps this component free of the state-clearing effect that would need.
  const [sized, setSized] = useState<Record<string, SizedProduct>>({})
  const [sizing, setSizing] = useState('')
  // How many go in at once. Six desks used to be six full trips through this
  // panel; a stepper is the whole fix.
  const [quantity, setQuantity] = useState(1)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/m/space-planner-for-shop/public/variations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId }),
        })
        if (response.status === 404) {
          if (!cancelled) onNothingToChoose()
          return
        }
        if (!response.ok) throw new Error('no options')
        const data = (await response.json()) as { payload: VariantSelectorPayload; currencySymbol: string; modelled: string[] }
        if (cancelled) return
        if (data.payload.options.length === 0) {
          onNothingToChoose()
          return
        }
        setLoaded({ payload: data.payload, currencySymbol: data.currencySymbol, modelled: new Set(data.modelled) })
        // An option with one value is not a question. Answering it for the
        // shopper is what stops a range with a single frame colour asking about
        // the frame colour.
        setSelection(withAutoSelected(data.payload, {}))
      } catch {
        if (!cancelled) setError('We could not load the choices for this one. Try again in a moment.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [productId, onNothingToChoose])

  const variant = useMemo(
    () => (loaded ? resolveVariant(loaded.payload, selection) : null),
    [loaded, selection],
  )

  const chosen = variant ? sized[variant.childProductId] ?? null : null

  // The chosen variation's real size, off the same route the planner uses for
  // everything already in the room - so what the panel prints here is exactly
  // what will be placed, rather than a second opinion about it.
  const childId = variant?.childProductId ?? ''
  const known = Boolean(chosen)
  useEffect(() => {
    if (!childId || known) return
    let cancelled = false
    void (async () => {
      setSizing(childId)
      try {
        const response = await fetch('/api/m/space-planner-for-shop/public/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: [childId] }),
        })
        if (!response.ok) throw new Error('no size')
        const data = (await response.json()) as { items: SizedProduct[] }
        const item = data.items[0]
        if (!cancelled && item) setSized((current) => ({ ...current, [childId]: { ...item, productId: item.id } }))
      } catch {
        // The size line simply does not appear. Placing still works - the
        // planner fetches the same thing again on the way in.
      } finally {
        if (!cancelled) setSizing('')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [childId, known])

  const choose = useCallback(
    (optionId: string, valueId: string) => {
      setSelection((current) => {
        // Tapping the chosen value again clears it, which is how somebody backs
        // out of a dead end without starting over.
        const next = { ...current }
        if (next[optionId] === valueId) delete next[optionId]
        else next[optionId] = valueId
        return next
      })
    },
    [],
  )

  const place = useCallback(() => {
    if (!variant) return
    if (chosen) {
      props.onPlace(chosen, quantity)
      return
    }
    // The size never arrived. Place it anyway on the ladder's answer for the
    // variation - the planner asks for the real numbers again as it lands, and a
    // shopper who has chosen a chair should get a chair.
    props.onPlace(
      {
        productId: variant.childProductId,
        name: props.productName,
        image: variant.imageUrls[0] ?? props.image,
        // The listing this child belongs to, so the browse card's "in the room"
        // count picks it up even on this fallback path.
        parentId: props.productId,
        // Formatted here only because the sized answer never came; everywhere else
        // the money is formatted server-side, tax display and all.
        priceFormatted: `${loaded?.currencySymbol ?? ''}${variant.price.toFixed(2)}`,
        price: variant.price,
        widthMm: 800,
        depthMm: 600,
        heightMm: 750,
        sizeSource: 'marker',
        mount: 'floor',
        underTopHeightMm: null,
        underTopWidthMm: null,
      },
      quantity,
    )
  }, [variant, chosen, props, loaded?.currencySymbol, quantity])

  if (error) {
    return (
      <div className="spl-stack">
        <button type="button" className="spl-btn spl-btn-sm" onClick={props.onCancel}>
          Back to the catalogue
        </button>
        <p className="spl-alert spl-alert-error">{error}</p>
      </div>
    )
  }

  if (!loaded) {
    return (
      <div className="spl-stack">
        <button type="button" className="spl-btn spl-btn-sm" onClick={props.onCancel}>
          Back to the catalogue
        </button>
        <p className="spl-note">Looking up the choices…</p>
      </div>
    )
  }

  const image = (variant?.imageUrls[0] ?? null) || props.image
  const size = chosen
  const missing = loaded.payload.options.filter((option, index) => isOptionVisible(loaded.payload, selection, index) && !selection[option.id])

  return (
    <div className="spl-stack">
      <button type="button" className="spl-btn spl-btn-sm" onClick={props.onCancel}>
        Back to the catalogue
      </button>

      <div className="spl-pick-head">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- same reasoning as the catalogue thumbnails: already sized by the media layer
          <img src={image} alt="" loading="lazy" />
        ) : (
          <span aria-hidden className="spl-pick-noimage" />
        )}
        <span>
          <strong>{props.productName}</strong>
          <span className="spl-note">Choose which one goes in the room.</span>
        </span>
      </div>

      {loaded.payload.options.map((option, index) => {
        if (!isOptionVisible(loaded.payload, selection, index)) return null
        const anyOut = option.values.some((value) => !isValueAvailable(loaded.payload, selection, option.id, value.id))
        return (
          <div key={option.id} className="spl-field">
            <span className="spl-pick-label">{option.name}</span>
            <div className="spl-pick-values">
              {option.values.map((value) => {
                const picked = selection[option.id] === value.id
                const available = isValueAvailable(loaded.payload, selection, option.id, value.id)
                const swatch = option.controlType === 'SWATCH' || option.controlType === 'IMAGE' ? value.swatch : null
                return (
                  <button
                    key={value.id}
                    type="button"
                    className={`spl-pick-value${picked ? ' is-picked' : ''}${available ? '' : ' is-out'}`}
                    aria-pressed={picked}
                    // Not disabled: a value that is out with the current picks is
                    // usually in with a different one, and a control you cannot
                    // press is a dead end you cannot get out of.
                    onClick={() => choose(option.id, value.id)}
                    title={available ? value.label : `${value.label} - not with the rest of your choices`}
                  >
                    {swatch && (swatch.startsWith('http') ? (
                      // eslint-disable-next-line @next/next/no-img-element -- swatch pictures are already thumbnail-sized in the media library
                      <img className="spl-pick-swatch" src={swatch} alt="" loading="lazy" />
                    ) : (
                      <span className="spl-pick-swatch" style={{ background: swatch }} aria-hidden />
                    ))}
                    <span>{value.label}</span>
                    {!available && <span className="spl-visually-hidden"> - not with the rest of your choices</span>}
                  </button>
                )
              })}
            </div>
            {/* Said in text, not in a hover tooltip: on a phone there is no
                hover, and a dimmed pill with no explanation reads as broken. */}
            {anyOut && <p className="spl-note spl-pick-outnote">Faded choices do not come with the rest of your picks - tap one anyway to switch to it.</p>}
          </div>
        )
      })}

      {variant ? (
        <div className="spl-pick-summary">
          <span className="spl-card-badges">
            {loaded.modelled.has(variant.childProductId) ? (
              <span className="spl-badge spl-badge-3d">3D</span>
            ) : (
              <span className="spl-badge">Sized box</span>
            )}
            {!variant.inStock && <span className="spl-badge spl-badge-warn">Out of stock</span>}
          </span>
          <span className="spl-note">
            {size
              ? `${size.priceFormatted} · ${Math.round(size.widthMm)} × ${Math.round(size.depthMm)} × ${Math.round(size.heightMm)} mm${size.sizeSource === 'category_default' || size.sizeSource === 'marker' ? ' (approx.)' : ''}`
              : sizing === variant.childProductId
                ? 'Working out the size…'
                : 'Ready to place.'}
          </span>
          <div className="spl-pick-qty">
            <span className="spl-pick-label" id="spl-pick-qty-label">How many?</span>
            <div className="spl-pick-qty-controls" role="group" aria-labelledby="spl-pick-qty-label">
              <button type="button" className="spl-btn spl-btn-sm" aria-label="One fewer" disabled={quantity <= 1} onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
                −
              </button>
              <span className="spl-pick-qty-count" aria-live="polite">{quantity}</span>
              <button type="button" className="spl-btn spl-btn-sm" aria-label="One more" disabled={quantity >= 20} onClick={() => setQuantity((q) => Math.min(20, q + 1))}>
                +
              </button>
            </div>
          </div>
          <button type="button" className="spl-btn spl-btn-primary" onClick={place}>
            {quantity > 1 ? `Put ${quantity} in the room` : 'Put this in the room'}
          </button>
        </div>
      ) : (
        <p className="spl-note">
          {missing.length > 0
            ? `Choose ${missing.map((option) => option.name.toLowerCase()).join(' and ')} to carry on.`
            : 'That combination is not one we make. Try another.'}
        </p>
      )}
    </div>
  )
}
