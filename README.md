# Space Planner for Shop

Lets a shopper draw their own room to scale, put your catalogue in it in 2D and 3D,
check what actually fits, and take away a floor plan, a priced item list and a quote
request.

It works on the 3D models you already have, and it does not need any of them: about
nineteen listings in twenty have no model at all, so a clean labelled block at the
right size is the main path rather than the fallback.

## Requires

| Module | Minimum | Why |
|---|---|---|
| `shop` | 0.1.192 | Catalogue, prices, tax display, and the cart utility (which is the version that syncs a member's basket between devices) |
| `product-3d-views-for-shop` | 0.1.82 | The `p3d_models` rows, the loader and its vendored decoders |
| `shop-variations` | 0.1.107 | Options resolving to the variant a shopper actually places |
| `quote-for-shop` | 0.1.8 | The quote pipeline. This module ships none of its own |

`product-attributes-for-shop` is **not** required. Spec attributes are read with raw
SQL behind a `to_regclass` probe, and the size ladder simply drops a rung on a shop
that has not installed it.

## What it adds

- **`/space-planner`** - the planner itself. Renders inside the site header and
  footer like every module public page, full-bleed within `<main>`.
- **`/space-planner/spaces`** - a member's saved rooms and the layouts inside them.
- **`/space-planner/shared/<token>`** - a read-only shared plan. Robots-disallowed.
- **Two Puck blocks** - a static teaser (the planner itself never loads on a page
  that merely carries the block) and a "See it in your room" button for product
  layouts.
- **A basket button**, via shop's `shop.cart-header-actions`.
- **A member account card and tab**, "My spaces".
- **Four admin screens** under their own sidebar section: rooms & plans, model
  corrections, sizes, and pictures.

## How sizes are worked out

Strictly in this order, cached in `spl_dimension_cache`, and never guessed:

1. **Measured from the 3D model.** Written by `scripts/calibrate.mjs`, which loads
   every distinct model file with node transforms applied. It cannot happen in a
   request: a route has sixty seconds and a model averages four megabytes.
2. **Parsed from the spec sheet** - Overall Width/Depth/Height, read as free text.
3. **A category default**, for the axes still missing. Badged "approx." in the UI.
4. **Typed in by hand** by the shopper. Nothing overwrites this.
5. **A labelled block**, so adding something to a plan is never blocked.

Where a measured model and a spec sheet disagree by more than a tenth, the row is
flagged rather than resolved. One of the two is wrong, and quietly preferring
either is how a beautifully rendered room ends up full of furniture that is not
the size it claims.

Anything the parser cannot read lands in the junk tail on the Sizes screen, with
the actual text, so somebody can fix the sheet.

## The one thing to be careful of

p3d's loader ends in `frameModel()`, which normalises every model to a two-unit
longest side. That is right for a product viewer and fatal for a planner. This
module takes the **pre-normalisation** bounding box and never calls it - see
`lib/three/planner-model.ts`. If rooms ever start looking convincingly wrong, start
there.

## Saving needs an account

Deliberately. A signed-out visitor gets the entire tool - their scratch room lives
in localStorage exactly as the basket does - and the save button is the sign-in
prompt. In exchange there are no anonymous rows, no guest retention sweep, no
adoption reconciliation and no unauthenticated write endpoint anywhere in the
module.

## Not in this build

Named rather than quietly missing:

- **Persisting crunched models to IndexedDB.** Prepared models are cached in memory
  for the life of the page, so a second visit re-downloads. This is the obvious next
  saving.
- **The photoreal render worker itself.** The enqueue route, the job table, the
  polling and the authenticated callback are all here, to the contract below; the
  Fly app that does the rendering is not part of this repo.
  Pictures stay switched off until `SPACE_PLANNER_RENDER_URL` and
  `SPACE_PLANNER_RENDER_SECRET` are set, and the admin says so plainly.
- **Delivery dates on the item list.** Wired to a `shop.delivery-estimates`
  extension point that `advanced-shipping-for-shop` does not publish yet. Absent,
  the column simply does not appear.
- **Whole-room GLB export**, room-level share links, owner-authored proposals, and
  everything else in §17 of the plan.

## Rooms of any shape

The flat plan is three tools on one canvas, switched by `mode` in `Plan2d.tsx`:

- **furnish** - arrange the furniture. The default.
- **shape** - drag the room's own corners, double-tap a wall to split it, remove a
  corner you do not want. Reached from **Room -> Change the shape**.
- **draw** - put a new outline down corner by corner, with walls snapping square
  and their length written on them as they go. Reached from the first-run screen
  or **Room -> Draw a new one**.

Both editing modes go through one reducer action, `set-shape`, whose `settle` flag
is the whole design: mid-gesture the vertices are taken exactly as given, and on
release they are wound, re-originned, the furniture is translated by the same
amount so it stays where it was in the room, and anything now outside the walls is
moved to the tray rather than left in the garden. An outline that folds through
itself is refused on release and the previous one is put back.

## Render worker contract

The worker receives `POST { jobId, scene, models, callbackUrl, callbackToken }`
with a `Bearer` of `SPACE_PLANNER_RENDER_SECRET`, renders the scene, uploads the
image itself, and calls back with `{ jobId, token, mediaId?, url?, error? }`. The
token is per job, so a leaked one is worthless the moment that job finishes.

`scene` is exactly what the browser draws from (`lib/scene/scene-plan.ts`). One
scene-assembly library, two consumers - a render assembled a second way is how
pictures quietly stop matching plans.

## Environment

| Variable | Required | What it does |
|---|---|---|
| `SPACE_PLANNER_RENDER_URL` | No | Where to send render jobs |
| `SPACE_PLANNER_RENDER_SECRET` | No | Shared secret for the outbound job |
| `CRON_SECRET` | No | Already documented in core; guards the nightly sweep |

## Tables

`spl_settings`, `spl_rooms`, `spl_plans`, `spl_plan_versions`, `spl_model_meta`,
`spl_category_defaults`, `spl_dimension_cache`, `spl_backfill_jobs`,
`spl_render_jobs`, `spl_events`.

Uninstalling with data removes all of them - and unlike an order or a review, the
customer has no copy of a plan anywhere else, so `code_only` (core's default, and
the one labelled "recommended") is very much the right answer unless somebody means
it. A member can export their own rooms and layouts through the ordinary account
data export; a bulk owner-side export of everybody's is not in this build.
