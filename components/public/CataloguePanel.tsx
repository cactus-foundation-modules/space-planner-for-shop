'use client'

import { useCallback, useEffect, useState } from 'react'
import type { CatalogueCard } from '@/modules/space-planner-for-shop/lib/catalogue'
import type { ProductInfo } from '@/modules/space-planner-for-shop/lib/client/planner-store'
import { VariationPicker } from '@/modules/space-planner-for-shop/components/public/VariationPicker'

// The browse panel.
//
// It browses at LISTING level and places at VARIANT level, exactly as the cart
// does - and it says which listings actually have a 3D model, because with
// nineteen in twenty carrying none, a panel that does not say so is a lucky dip.
//
// "Places at variant level" was a statement of intent until the picker: tapping
// a card placed the LISTING, whose size row describes the family rather than any
// member of it, so a boardroom table that comes in 180 and 240 cm arrived in the
// category default's 800 mm footprint. A card that stands for a family now opens
// the choices instead of placing anything, and what goes in the room is the
// variation the shopper picked, at its own size and its own price.

export type CataloguePanelProps = {
  onPlace: (card: CatalogueCard) => void
  /** A specific variation, already sized and priced. See VariationPicker. */
  onPlaceProduct: (info: ProductInfo) => void
}

type Category = { id: string; name: string; slug: string }

export function CataloguePanel(props: CataloguePanelProps) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [modelledOnly, setModelledOnly] = useState(false)
  const [cards, setCards] = useState<CatalogueCard[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [choosing, setChoosing] = useState<CatalogueCard | null>(null)

  const load = useCallback(
    async (nextPage: number, term: string, categorySlug: string) => {
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({ page: String(nextPage), perPage: '24', withCategories: '1' })
        if (term) params.set('search', term)
        if (categorySlug) params.set('category', categorySlug)
        const response = await fetch(`/api/m/space-planner-for-shop/public/catalogue?${params.toString()}`)
        if (!response.ok) throw new Error('Could not load the catalogue')
        const data = (await response.json()) as { cards: CatalogueCard[]; total: number; categories?: Category[] }
        setCards(data.cards)
        setTotal(data.total)
        if (data.categories) setCategories(data.categories)
      } catch {
        setError('We could not load the catalogue just now. Try again in a moment.')
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    // Debounced, so typing "desk" is one query rather than four.
    const timer = setTimeout(() => {
      setPage(1)
      void load(1, search, category)
    }, 250)
    return () => clearTimeout(timer)
  }, [search, category, load])

  const shown = modelledOnly ? cards.filter((card) => card.hasModel) : cards

  // Stable, because the picker's option-list fetch depends on the one it is
  // handed: rebuilt every render, typing in the search box behind the picker
  // would re-fetch the whole option list on every keystroke.
  const cancelChoosing = useCallback(() => setChoosing(null), [])
  const { onPlace, onPlaceProduct } = props
  const placeChosen = useCallback(
    (info: ProductInfo) => {
      onPlaceProduct(info)
      setChoosing(null)
    },
    [onPlaceProduct],
  )
  // Depends on the open card, which only changes when the picker opens or
  // closes - and it is keyed by product, so it mounts fresh either way.
  const placeWholeListing = useCallback(() => {
    if (choosing) onPlace(choosing)
    setChoosing(null)
  }, [choosing, onPlace])

  // The panel becomes the picker rather than opening a dialog over it. On a
  // phone the panel IS the screen, and a modal on top of it is one more thing to
  // dismiss; the way back is a plain button at the top, where the browser's own
  // back gesture would put it.
  if (choosing) {
    return (
      <VariationPicker
        // Keyed by product so opening a second thing starts clean: the picker
        // holds the shopper's picks and the sizes it has looked up, and neither
        // means anything about a different range.
        key={choosing.id}
        productId={choosing.id}
        productName={choosing.name}
        image={choosing.image}
        onCancel={cancelChoosing}
        onPlace={placeChosen}
        onNothingToChoose={placeWholeListing}
      />
    )
  }

  return (
    <div className="spl-stack">
      {/* Sticky within the panel's own scroll, so page two of the catalogue is
          never a long scroll away from the search box that produced it. On a
          phone the two fields share a row and the labels go visually quiet -
          the placeholder and the "All categories" option say the same thing
          without spending two lines of a screen that is mostly spoken for. */}
      <div className="spl-cat-head">
        <div className="spl-cat-filters">
          <div className="spl-field">
            <label htmlFor="spl-search">Search the catalogue</label>
            <input
              id="spl-search"
              className="spl-input"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Desks, chairs, pedestals…"
            />
          </div>

          <div className="spl-field">
            <label htmlFor="spl-category">Category</label>
            <select id="spl-category" className="spl-select" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">All categories</option>
              {categories.map((entry) => (
                <option key={entry.id} value={entry.slug}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="spl-check">
          <input type="checkbox" checked={modelledOnly} onChange={(event) => setModelledOnly(event.target.checked)} />
          <span>Only things with a 3D model</span>
        </label>
      </div>

      {error && <p className="spl-alert spl-alert-error">{error}</p>}
      {loading && <p className="spl-note">Looking…</p>}

      <ul className="spl-list">
        {shown.map((card) => (
          <li key={card.id}>
            <button
              type="button"
              className="spl-card"
              onClick={() => (card.hasVariations ? setChoosing(card) : props.onPlace(card))}
            >
              {card.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- catalogue thumbnails are already sized by the media layer and this list is virtual-scrolled by the browser, not by next/image
                <img src={card.image} alt="" loading="lazy" />
              ) : (
                <span aria-hidden className="spl-card-noimage" />
              )}
              <span className="spl-card-body">
                <span className="spl-card-name">{card.name}</span>
                <span className="spl-card-meta">
                  {card.hasVariations ? (
                    // A family's own size row is nobody's size, so printing it
                    // here is a small lie the shopper only finds out about once
                    // the thing is in the room at the wrong size.
                    <>{card.priceFormatted} · choose a size or finish</>
                  ) : (
                    <>
                      {card.priceFormatted} · {Math.round(card.widthMm)} × {Math.round(card.depthMm)} mm
                      {card.approximateSize && ' (approx.)'}
                    </>
                  )}
                </span>
                <span className="spl-card-badges">
                  {card.hasModel && <span className="spl-badge spl-badge-3d">3D</span>}
                  {card.madeToOrder && <span className="spl-badge">Made to order</span>}
                  {card.stockLabel && <span className="spl-badge spl-badge-warn">{card.stockLabel}</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {shown.length === 0 && !loading && <p className="spl-note">Nothing matches that. Try a shorter word.</p>}

      {total > cards.length && (
        <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'space-between' }}>
          <button type="button" className="spl-btn" disabled={page <= 1} onClick={() => { const next = page - 1; setPage(next); void load(next, search, category) }}>
            Back
          </button>
          <span className="spl-note">Page {page}</span>
          <button type="button" className="spl-btn" disabled={page * 24 >= total} onClick={() => { const next = page + 1; setPage(next); void load(next, search, category) }}>
            More
          </button>
        </div>
      )}
    </div>
  )
}
