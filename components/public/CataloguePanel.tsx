'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  onPlaceProduct: (info: ProductInfo, quantity?: number) => void
  /** How many of each product (and each product's listing) are in the room. */
  placedCounts: Record<string, number>
}

type Category = { id: string; name: string; slug: string; parentId: string | null }

const PER_PAGE = 24

export function CataloguePanel(props: CataloguePanelProps) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [modelledOnly, setModelledOnly] = useState(false)
  const [cards, setCards] = useState<CatalogueCard[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  // True from the off. The first fetch sits behind a 250ms debounce, so an
  // empty list at first paint is "we have not looked yet" rather than "nothing
  // matches" - which is what every visit used to be told for a quarter of a
  // second, against a search box nobody had typed in.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [choosing, setChoosing] = useState<CatalogueCard | null>(null)

  // Which request is the current one. Typing and paging fire overlapping
  // fetches, and on a slow connection they come back in whatever order they
  // please: without this, the page-two response could land on top of the
  // fresher search the shopper had already typed. Only the latest request may
  // write - and it doubles as the unmount guard, since the cleanup bumps it.
  const requestSeq = useRef(0)
  useEffect(() => () => { requestSeq.current += 1 }, [])
  /** The panel's own root, used to find the scroll box it sits in. */
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(
    async (nextPage: number, term: string, categorySlug: string, modelled: boolean) => {
      const seq = ++requestSeq.current
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({ page: String(nextPage), perPage: String(PER_PAGE), withCategories: '1' })
        if (term) params.set('search', term)
        if (categorySlug) params.set('category', categorySlug)
        // Server-side, so the page numbers stay honest: filtering a fetched
        // page here used to show one or two cards while "More" promised
        // hundreds.
        if (modelled) params.set('modelledOnly', '1')
        const response = await fetch(`/api/m/space-planner-for-shop/public/catalogue?${params.toString()}`)
        if (!response.ok) throw new Error('Could not load the catalogue')
        const data = (await response.json()) as { cards: CatalogueCard[]; total: number; categories?: Category[] }
        if (seq !== requestSeq.current) return
        setCards(data.cards)
        setTotal(data.total)
        if (data.categories) setCategories(data.categories)
      } catch {
        if (seq !== requestSeq.current) return
        setError('We could not load the catalogue just now. Try again in a moment.')
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    // Debounced, so typing "desk" is one query rather than four.
    const timer = setTimeout(() => {
      setPage(1)
      void load(1, search, category, modelledOnly)
    }, 250)
    return () => clearTimeout(timer)
  }, [search, category, modelledOnly, load])

  // Sections first, their leaves under each, everything alphabetical - fifty
  // categories in one long unordered list was a memory test, not a filter.
  const grouped = useMemo(() => {
    const parents = categories.filter((entry) => !entry.parentId).sort((a, b) => a.name.localeCompare(b.name))
    const byParent = new Map<string, Category[]>()
    const orphans: Category[] = []
    const parentIds = new Set(parents.map((entry) => entry.id))
    for (const entry of categories) {
      if (!entry.parentId) continue
      if (!parentIds.has(entry.parentId)) {
        orphans.push(entry)
        continue
      }
      const list = byParent.get(entry.parentId) ?? []
      list.push(entry)
      byParent.set(entry.parentId, list)
    }
    for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    orphans.sort((a, b) => a.name.localeCompare(b.name))
    return { parents, byParent, orphans }
  }, [categories])

  // Stable, because the picker's option-list fetch depends on the one it is
  // handed: rebuilt every render, typing in the search box behind the picker
  // would re-fetch the whole option list on every keystroke.
  const cancelChoosing = useCallback(() => setChoosing(null), [])
  const { onPlace, onPlaceProduct } = props
  const placeChosen = useCallback(
    (info: ProductInfo, quantity?: number) => {
      onPlaceProduct(info, quantity)
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

  /**
   * Turn to a page, and go back to the top of the list.
   *
   * The panel scrolls itself, so without the scroll the next page arrived with
   * the shopper still parked at the bottom of it - which on a phone, where the
   * panel is half the screen, reads as the button having done nothing.
   */
  const turnTo = useCallback(
    (nextPage: number) => {
      setPage(nextPage)
      void load(nextPage, search, category, modelledOnly)
      scrollRef.current?.closest('.spl-side-scroll')?.scrollTo({ top: 0 })
    },
    [load, search, category, modelledOnly],
  )

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

  const shownFrom = total === 0 ? 0 : (page - 1) * PER_PAGE + 1
  const shownTo = Math.min(total, (page - 1) * PER_PAGE + cards.length)
  // Said on every search, not only when there is a second page. The count used
  // to live inside the pager, which appears at twenty-five results and up, so
  // anybody whose search actually narrowed things down was told nothing.
  const countLine =
    total > cards.length ? `Showing ${shownFrom}–${shownTo} of ${total}` : `${total} ${total === 1 ? 'match' : 'matches'}`

  return (
    <div className="spl-stack" ref={scrollRef}>
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
              {grouped.parents.map((parent) => {
                const leaves = grouped.byParent.get(parent.id) ?? []
                if (leaves.length === 0) {
                  return (
                    <option key={parent.id} value={parent.slug}>
                      {parent.name}
                    </option>
                  )
                }
                return (
                  <optgroup key={parent.id} label={parent.name}>
                    <option value={parent.slug}>All {parent.name.toLowerCase()}</option>
                    {leaves.map((leaf) => (
                      <option key={leaf.id} value={leaf.slug}>
                        {leaf.name}
                      </option>
                    ))}
                  </optgroup>
                )
              })}
              {grouped.orphans.map((entry) => (
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

      {/* How the search went, in one place that is mounted from the start and
          never unmounted - a live region that appears along with its message is
          not reliably read out, so somebody using a screen reader typed "desk"
          and was told nothing at all: not the count, not that it had failed. */}
      <div aria-live="polite">
        {error ? (
          // With a way back. Nothing else re-runs the fetch: the debounced
          // effect only fires on a changed search, and the pager only exists
          // above twenty-four results - which a failed load never has. One
          // dropped request used to leave the panel dead until a page reload.
          <p className="spl-alert spl-alert-error">
            <span className="spl-alert-text">{error}</span>
            <button type="button" className="spl-btn spl-btn-sm" onClick={() => void load(page, search, category, modelledOnly)}>
              Try again
            </button>
          </p>
        ) : loading ? (
          <p className="spl-note">Looking…</p>
        ) : cards.length === 0 ? (
          <p className="spl-note">
            {/* "Try a shorter word" was shown on a first visit with an empty
                search box and no category chosen - i.e. when the panel can see
                nothing in the shop at all - and there is nothing to shorten. */}
            {search.trim() || category
              ? modelledOnly
                ? 'Nothing with a 3D model matches that. Untick the box to see everything.'
                : 'Nothing matches that. Try a shorter word.'
              : modelledOnly
                ? 'Nothing in the shop has a 3D model yet. Untick the box to place anything at its right size.'
                : 'There is nothing to show from the shop just now.'}
          </p>
        ) : (
          <p className="spl-note">{countLine}</p>
        )}
      </div>

      <ul className="spl-list">
        {cards.map((card) => {
          const inRoom = props.placedCounts[card.id] ?? 0
          return (
            <li key={card.id}>
              <button
                type="button"
                className="spl-card"
                aria-label={`${card.name}, ${card.priceFormatted}${card.hasVariations ? ', choose a size or finish' : ''}${inRoom > 0 ? `, ${inRoom} in the room` : ''}`}
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
                    {inRoom > 0 && <span className="spl-badge spl-badge-count">{inRoom} in the room</span>}
                    {card.hasModel && <span className="spl-badge spl-badge-3d">3D</span>}
                    {card.madeToOrder && <span className="spl-badge">Made to order</span>}
                    {card.stockLabel && <span className="spl-badge spl-badge-warn">{card.stockLabel}</span>}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {total > PER_PAGE && (
        <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'space-between', alignItems: 'center' }}>
          <button type="button" className="spl-btn" disabled={page <= 1} onClick={() => turnTo(page - 1)}>
            Back
          </button>
          <button type="button" className="spl-btn" disabled={page * PER_PAGE >= total} onClick={() => turnTo(page + 1)}>
            More
          </button>
        </div>
      )}
    </div>
  )
}
