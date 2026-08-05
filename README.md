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

## Staff only, out of the box

`adminOnly` in the module settings, **on by default**. It is a whole feature, and an
owner is entitled to decide it is not ready for paying customers yet.

While it is on, `plannerVisible()` (`lib/visibility.ts`) is false for everyone except
an admin session carrying `space-planner.access` or `space-planner.manage`, and the
planner is not on the storefront at all: no basket button, no product button, no
teaser, no member tab, `/space-planner` and `/space-planner/spaces` answer `notFound()`,
and the public data routes plus every member route (all of which come through
`requireMember`) answer 404 rather than 403 - a hidden feature that says "forbidden"
has announced itself.

Modelled on shop's `getShopGate`: the session cookie is read **only** on the restricted
path, so a public planner can never be the thing that drags a cached page into a
per-request render. The Puck teaser is the one surface checked against the setting
alone, without a session, because it sits on prerendered pages - which also means it
can lag a change to the switch until that page is next saved. Nothing else does, and
the address itself never does, so a stale teaser is a dead button rather than a leak.

Two deliberate exemptions: `/space-planner/shared/<token>` (somebody pressed share and
sent it to a named person - that is what a staff-only planner is *for*, though the
"open the planner" link at the bottom goes), and `/space-planner/render/<id>` (the
render worker is a browser holding a signed token, not a member of staff).

Saving is unchanged: rooms and plans belong to a `Member`, so staff who want to keep
one need a customer account like everybody else.

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

## What the shopper can do with it

- **Draw or type the room**, of any number of walls, and put doors and windows in
  the walls.
- **Place things from the catalogue**, drag them about, and turn them by the handle
  on the selected one. Dragging snaps to the walls and to the other furniture -
  edge to edge, and lined up on the other axis - so a bank of desks actually
  touches. Hold `alt` to escape any of it.
- **Look at it flat or in 3D**, with perspective on for how it will look and off
  for a drawing you can compare sizes on.
- **Take it away**: add the lot to the basket, ask for a quote, email it to
  themselves, or export a PDF - the room's measurements and the priced item list
  always, the flat plan, the 3D view and a quote page by choice.
- **Ask for a photograph of it**, where the owner has switched pictures on and the
  picture service is wired up. **Make a photo** in the toolbar opens the pictures
  already taken of that layout and a button to ask for another; the dialog posts,
  polls, and is perfectly happy to be closed while the machine works. The button
  is absent unless `rendersEnabled` **and** `renderWorkerConfigured()` are both
  true, worked out on the server - a button that answers "not set up on this site
  yet" is worse than no button. Every ask saves the plan on the way, because the
  picture is built server-side from the saved layout.

## How sizes are worked out

Strictly in this order, cached in `spl_dimension_cache`, and never guessed:

1. **Measured from the 3D model.** Written by the **Measure** button on the Sizes
   screen, which loads every distinct model file in the admin's own browser with
   node transforms and the file's yaw correction applied, and posts the extents
   back in batches (`/admin/dimensions/measure`). It cannot happen in a request: a
   route has sixty seconds and a model averages four megabytes. Doing it in the
   browser is not a compromise - it means the number banked is the extent of the
   mesh the planner actually puts in the room.
2. **Parsed from the spec sheet** - Overall Width/Depth/Height, read as free text.
   A variation inherits its listing's values for any axis it does not state
   itself, which is what it takes to size a range that lists its dimensions once
   and its colours twelve times.
3. **A category default**, for the axes still missing. Badged "approx." in the UI.
4. **Typed in by hand** by the shopper. Nothing overwrites this, including a
   measurement.
5. **A labelled block**, so adding something to a plan is never blocked.

Where a measured model and a spec sheet disagree by more than a tenth, the row is
flagged rather than resolved. One of the two is wrong, and quietly preferring
either is how a beautifully rendered room ends up full of furniture that is not
the size it claims.

Anything the parser cannot read lands in the junk tail on the Sizes screen, with
the actual text, so somebody can fix the sheet.

## Fitting the mesh to the size

The plan and the model are two independent statements about how big a thing is,
and `lib/three/model-scale.ts` reconciles them on every placement. It used to be
three divisions - width over width, height over height, depth over depth - which
is right until one of the six numbers is wrong, and then it is the worst possible
answer: a single bad axis does not draw a small chair, it draws a squashed one,
which reads as a broken tool rather than as bad data.

So an axis ratio outside 0.4-2.5 is treated as a data fault and dropped, an
**approximate** size never deforms a real mesh, and axis ratios that disagree with
each other by more than half fall back to a uniform fit. Below those thresholds
per-axis scaling stays, because it is genuinely right: this catalogue's suppliers
widen a desk by sliding its ends apart, so one model legitimately serves several
widths.

## Colours

Most of this catalogue is one model file per SHAPE, with the fabric painted on at
view time from the shopper's chosen swatch - so a planner that just loads the file
draws a room of white chairs. `lib/model-resolver.ts` asks p3d for the same
`FabricBundle` its own viewer uses and hands the slots to the client, where
`paintedModel()` clones the materials named in them and paints the clones.

Three things worth knowing:

- **The paints are part of the instancing identity.** A scene node carries a
  `fabricKey`, and instance groups are keyed on file *plus* paints - otherwise a
  room holding a blue chair and a black one drew whichever resolved first, twice.
- **Materials are cloned before painting.** Prepared models are shared by every
  placement of that file, and three.js clones share materials by reference.
- **A listing stands in for its first variation.** The browse panel places a
  listing, and a listing has no colours of its own, so it borrows the first
  enabled variation's - the same one the product page opens on.

Bundles are cached per server instance for a minute: each resolve is around eight
queries, one of which reads the shop's whole swatch vocabulary, and the planner
asks for the same roomful again on every load, save and render.

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
- **Persisting the picture machine's browser between jobs.** Every render pays a
  cold Chromium start. Worth doing only if renders ever become frequent enough
  for a machine to catch a second job before its idle clock runs out, which today
  they are not.
- **Delivery dates on the item list.** Wired to a `shop.delivery-estimates`
  extension point that `advanced-shipping-for-shop` does not publish yet. Absent,
  the column simply does not appear.
- **Whole-room GLB export**, room-level share links, owner-authored proposals, and
  everything else in §17 of the plan.

## Rooms of any shape

The flat plan is four tools on one canvas, switched by `mode` in `Plan2d.tsx`:

- **furnish** - arrange the furniture. The default.
- **shape** - drag the room's own corners, double-tap a wall to split it, remove a
  corner you do not want. Reached from **Room -> Change the shape**.
- **openings** - put doors, windows and plain gaps on the walls, and slide them
  along. Reached from **Room -> Doors & windows**.
- **draw** - put a new outline down corner by corner, with walls snapping square
  and their length written on them as they go. Reached from the first-run screen
  or **Room -> Draw a new one**.

A door or a window belongs to the ROOM rather than to a layout, so it lives in the
geometry beside the wall it is cut into: one survives a plan being copied, comes
along when the wall is dragged, and is what the 3D view builds a lintel over.
Anything that moves the walls puts every opening back on the wall it belongs to -
slid along if it now hangs off the end, narrowed if the wall has become shorter
than it is, and dropped only when the wall can no longer hold it at all.

Both outline-editing modes go through one reducer action, `set-shape`, whose `settle` flag
is the whole design: mid-gesture the vertices are taken exactly as given, and on
release they are wound, re-originned, the furniture is translated by the same
amount so it stays where it was in the room, and anything now outside the walls is
moved to the tray rather than left in the garden. An outline that folds through
itself is refused on release and the previous one is put back.

## The PDF export

`POST /api/m/space-planner-for-shop/member/plans/<id>/pdf`, member-tier and rate
limited on the same window as pictures, because every call starts a headless
browser. The document itself is composed in `lib/export-doc.ts` and printed by
`lib/pdf.ts` - the same two-environment chromium arrangement quote-for-shop uses,
copied rather than imported, because a dependent module does not reach into the
module it depends on to add exports to it.

The two drawings are photographed IN THE BROWSER and posted up as data URLs. They
are pictures of what the shopper is looking at, at the zoom and the angle they
chose, and half of that state never leaves their tab. Prices are the other way
round and always: the item list is built server-side from the saved plan through
shop's own price resolution, exactly as the quote route does it. The optional
quote page takes its heading, intro, terms, validity note and hide-prices rule
from quote-for-shop's settings, and carries the real quote number when the plan
has already been through the quote flow.

## The picture service

Owner-provisioned, from the Pictures screen. One button when the site already has
a Fly.io key - which it usually does, because the video converter wanted one
first (`lib/media/media-worker-config.ts`, or `MEDIA_WORKER_FLY_TOKEN` /
`SEQUENCE_FLY_TOKEN`) - and one box plus one button when it does not. Pressing it
creates a Fly app and a shared IPv4 and nothing else: **no machine exists between
renders**.

Each render then gets a machine of its own (`performance-8x`, 16GB, the same
shape as core's video converter) created at enqueue time and destroyed when the
picture lands. Ten shoppers asking at once get ten machines and ten pictures at
once, which costs what ten one after another would have cost and takes a tenth as
long. `maxRenderMachines` is a spend ceiling, not a queue depth: past it a
shopper is asked to try again in a minute.

Three independent things end a machine, because the one that costs money is the
one that outlives its job:

1. the callback destroys it the moment the picture is filed;
2. `auto_destroy` + `restart: 'no'` + the worker's own idle exit;
3. the nightly sweep destroys anything no live job claims.

`SPACE_PLANNER_RENDER_URL` still works and still wins, for a worker somebody runs
themselves. Nothing is created for it and nothing is destroyed - not our machine,
not our lifecycle.

### Worker contract

The worker gets `POST { jobId, pageUrl, width, height, uploadUrl, uploadToken,
uploadContentType, callbackUrl, callbackToken }` with a `Bearer` of the app's
worker token, and answers `{ jobId, token, sizeBytes }` or `{ jobId, token,
error }`. Both tokens are per job, so a leaked one is worthless the moment that
job finishes, and nothing accepts image bytes - the picture goes straight to
storage under a key the site chose before the machine existed.

**The worker does not draw the room.** It opens `pageUrl` - served by this module
at `/space-planner/render/[id]` - waits for that page to set
`window.__splRenderReady`, and photographs it. So the renderer is
`lib/three/planner-scene.ts`, the same code the shopper was looking at when they
pressed the button, and there is no second implementation to drift from it.
Source: `cactus-foundation-modules/space-planner-render-worker`.

## Environment

| Variable | Required | What it does |
|---|---|---|
| `SPACE_PLANNER_RENDER_URL` | No | A picture service you run yourself. Set, and the button is not offered |
| `SPACE_PLANNER_RENDER_SECRET` | No | Shared secret for that outbound job |
| `CRON_SECRET` | No | Already documented in core; guards the nightly sweep |

Nothing needs setting for the provisioned path - the Fly key, the app name and
the worker token all live in `spl_render_worker`.

## Tables

`spl_settings`, `spl_rooms`, `spl_plans`, `spl_plan_versions`, `spl_model_meta`,
`spl_category_defaults`, `spl_dimension_cache`, `spl_backfill_jobs`,
`spl_render_jobs`, `spl_render_worker`, `spl_events`.

Uninstalling with data removes all of them - and unlike an order or a review, the
customer has no copy of a plan anywhere else, so `code_only` (core's default, and
the one labelled "recommended") is very much the right answer unless somebody means
it. A member can export their own rooms and layouts through the ordinary account
data export; a bulk owner-side export of everybody's is not in this build.
