'use client'

import { useCallback, useEffect, useState } from 'react'
import type { CatalogueCard } from '@/modules/space-planner-for-shop/lib/catalogue'

// The browse panel.
//
// It browses at LISTING level and places at VARIANT level, exactly as the cart
// does - and it says which listings actually have a 3D model, because with
// nineteen in twenty carrying none, a panel that does not say so is a lucky dip.

export type CataloguePanelProps = {
  onPlace: (card: CatalogueCard) => void
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

  return (
    <div className="spl-stack">
      <div className="spl-field">
        <label htmlFor="spl-search">Search the catalogue</label>
        <input
          id="spl-search"
          className="spl-input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Desks, chairs, pedestals…"
        />
      </div>

      <div className="spl-field">
        <label htmlFor="spl-category">Category</label>
        <select id="spl-category" className="spl-select" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">Everything</option>
          {categories.map((entry) => (
            <option key={entry.id} value={entry.slug}>
              {entry.name}
            </option>
          ))}
        </select>
      </div>

      <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', fontSize: 'var(--text-sm)' }}>
        <input type="checkbox" checked={modelledOnly} onChange={(event) => setModelledOnly(event.target.checked)} />
        Only things with a 3D model
      </label>

      {error && <p className="spl-alert spl-alert-error">{error}</p>}
      {loading && <p className="spl-note">Looking…</p>}

      <ul className="spl-list">
        {shown.map((card) => (
          <li key={card.id}>
            <button type="button" className="spl-card" onClick={() => props.onPlace(card)}>
              {card.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- catalogue thumbnails are already sized by the media layer and this list is virtual-scrolled by the browser, not by next/image
                <img src={card.image} alt="" loading="lazy" />
              ) : (
                <span aria-hidden style={{ width: '3rem', height: '3rem', borderRadius: 4, background: 'var(--color-surface)' }} />
              )}
              <span className="spl-card-body">
                <span className="spl-card-name">{card.name}</span>
                <span className="spl-card-meta">
                  {card.priceFormatted} · {Math.round(card.widthMm)} × {Math.round(card.depthMm)} mm
                  {card.approximateSize && ' (approx.)'}
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
