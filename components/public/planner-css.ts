// One stylesheet for the whole planner, injected once by the root component.
//
// Semantic tokens throughout - no hex anywhere in the chrome, so the planner
// follows whatever theme the site is wearing and passes AA in light and dark
// without a second set of rules. The only literal colours in this module are
// inside the 3D scene, where they are materials rather than chrome.
//
// Layout target: an APPLICATION, not a document. Module public pages always
// render inside the site header and footer on this platform - there is no
// chrome-free route - so "full screen" means the viewport minus the sticky
// header. The planner claims exactly that much and no more: the workspace has a
// definite height, and the two things inside it scroll themselves.
//
// That is not a nicety. Without a definite height the browse panel - which is a
// catalogue page, two dozen cards long - decides how tall the row is, the plan
// canvas stretches to match, and the whole page ends up eight thousand pixels
// tall with the room drawn postage-stamp size in the middle of it.
export const PLANNER_HEADER_ALLOWANCE = '76px'

export function plannerCss(): string {
  return `
.spl-root {
  /* The sticky site header, plus the page wrapper's own padding top and bottom.
     Both are real and both have to come off, or the workspace overflows the
     viewport by exactly the amount nobody can see. */
  --spl-chrome: ${PLANNER_HEADER_ALLOWANCE};
  --spl-gap: var(--space-3, 0.75rem);
  --spl-radius: var(--radius-md, 10px);
  --spl-control-h: 2.25rem;
  /* Muted text, mixed from the theme's OWN text and background rather than taken
     from --color-text-muted, which on this theme sits at about 2.4:1 on white -
     fine for a decorative caption, nowhere near AA for the twelve-point print
     this tool is full of. Mixing keeps it theme-following and automatically
     correct in dark mode, where the mix runs the other way. */
  --spl-muted: color-mix(in srgb, var(--color-text) 68%, var(--color-bg));
  display: flex;
  flex-direction: column;
  gap: var(--spl-gap);
  /* dvh, not vh: on a phone the browser's own chrome slides in and out, and vh
     measures the tallest it ever gets - which is how a toolbar ends up under the
     address bar. */
  height: calc(100dvh - var(--spl-chrome) - (var(--spl-gap) * 2));
  min-height: 34rem;
  color: var(--color-text);
}
/* The opening screen is a card, not an application: it sizes to its content and
   sits in the middle of the page rather than propping open a viewport-tall box
   with nothing in it. */
.spl-root.spl-root-intro {
  height: auto;
  min-height: 0;
  display: block;
}

.spl-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spl-gap);
  padding: var(--spl-gap);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  flex: 0 0 auto;
}
.spl-bar-heading { display: grid; gap: 0.1rem; min-width: 0; }
.spl-bar-spacer { flex: 1 1 auto; }
.spl-bar-actions { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.spl-title {
  font-size: var(--text-lg, 1.1rem);
  font-weight: 600;
  margin: 0;
  color: var(--color-text);
  line-height: 1.2;
}
.spl-sub { color: var(--spl-muted); font-size: var(--text-sm, 0.875rem); }

.spl-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 22rem;
  gap: var(--spl-gap);
  align-items: stretch;
  /* Both of these matter: flex:1 claims the leftover height, min-height:0 lets
     the children be shorter than their content and scroll instead. */
  flex: 1 1 auto;
  min-height: 0;
}

.spl-stage {
  position: relative;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  overflow: hidden;
  min-height: 0;
}
.spl-stage canvas { display: block; width: 100%; height: 100%; touch-action: none; }

.spl-side {
  display: flex;
  flex-direction: column;
  gap: var(--spl-gap);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  padding: var(--spl-gap);
  overflow: hidden;
  min-height: 0;
}
/* The panel's tabs stay put and only the panel's contents move - a browse list
   that scrolls its own switcher off the top is a list you have to scroll back up
   to escape. */
.spl-side > .spl-tabs { flex: 0 0 auto; }
.spl-side-scroll { overflow: auto; overscroll-behavior: contain; min-height: 0; flex: 1 1 auto; }

.spl-tabs { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.spl-tab {
  appearance: none;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  border-radius: var(--radius-sm, 6px);
  padding: 0 0.7rem;
  min-height: var(--spl-control-h);
  font-size: var(--text-sm, 0.875rem);
  font-family: inherit;
  cursor: pointer;
}
.spl-tab[aria-selected="true"],
.spl-tab[aria-selected="true"]:hover,
.spl-tab[aria-selected="true"]:focus {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-primary-contrast, #fff);
}
.spl-tab:hover:not([aria-selected="true"]) { border-color: var(--color-primary); background: var(--color-surface); color: var(--color-text); }
.spl-tab:focus-visible, .spl-btn:focus-visible, .spl-input:focus-visible, .spl-select:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.spl-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  border-radius: var(--radius-sm, 6px);
  padding: 0 0.75rem;
  min-height: var(--spl-control-h);
  font-size: var(--text-sm, 0.875rem);
  font-family: inherit;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}
/* The overflow toggle only exists on a phone; on a wide toolbar every action
   fits and a disclosure would be one more thing to press for nothing. Declared
   after .spl-btn on purpose - both are one class deep, so the later rule is the
   one that wins, and the other way round the toggle showed up on every desktop. */
.spl-bar-actions .spl-more-toggle { display: none; }
.spl-btn:hover:not(:disabled) { border-color: var(--color-primary); }
.spl-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.spl-btn-primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-primary-contrast, #fff);
}
.spl-btn-danger { color: var(--color-danger, #b3261e); border-color: var(--color-danger, #b3261e); }
.spl-btn-icon { padding: 0 0.5rem; }

.spl-input, .spl-select {
  width: 100%;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  padding: 0.4rem 0.5rem;
  min-height: var(--spl-control-h);
  font-size: var(--text-sm, 0.875rem);
  font-family: inherit;
}
.spl-field { display: grid; gap: 0.25rem; min-width: 0; }
.spl-field label { font-size: var(--text-xs, 0.75rem); color: var(--spl-muted); }
.spl-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; }
.spl-stack { display: grid; gap: 0.6rem; }
.spl-buttons { display: flex; gap: 0.4rem; flex-wrap: wrap; }
/* A tick and its wording, sized so the whole line is the hit target. */
.spl-check { display: flex; gap: 0.5rem; align-items: flex-start; font-size: var(--text-sm, 0.875rem); cursor: pointer; }
.spl-check input { margin-top: 0.15rem; flex: none; }
/* In the toolbar the tick sits on the same line as everything else in it. */
.spl-bar-check { align-items: center; white-space: nowrap; color: var(--spl-muted); }
.spl-bar-check input { margin-top: 0; }
/* Label beside its control rather than above it, for the toolbars. */
.spl-field-inline { grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0.35rem; }
.spl-input-sm, .spl-select-sm { width: 6.5rem; min-height: 2rem; padding: 0.2rem 0.4rem; }

.spl-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.spl-card {
  display: grid;
  grid-template-columns: 3rem minmax(0, 1fr);
  gap: 0.6rem;
  align-items: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  padding: 0.45rem;
  background: var(--color-bg);
  text-align: left;
  width: 100%;
  cursor: pointer;
  color: var(--color-text);
  font-family: inherit;
}
.spl-card:hover { border-color: var(--color-primary); }
.spl-card:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.spl-card img { width: 3rem; height: 3rem; object-fit: contain; border-radius: 4px; background: var(--color-surface); }
.spl-card-body { display: grid; gap: 0.15rem; min-width: 0; }
.spl-card-name { font-size: var(--text-sm, 0.875rem); line-height: 1.25; }
.spl-card-meta { font-size: var(--text-xs, 0.75rem); color: var(--spl-muted); }
.spl-card-badges { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.spl-card-badges:empty { display: none; }

.spl-badge {
  display: inline-block;
  font-size: var(--text-xs, 0.75rem);
  padding: 0.05rem 0.35rem;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  color: var(--spl-muted);
}
.spl-badge-3d { border-color: var(--color-primary); color: var(--color-primary); }
.spl-badge-warn { border-color: var(--color-warning, #a16207); color: var(--color-warning, #a16207); }

.spl-note {
  font-size: var(--text-xs, 0.75rem);
  color: var(--spl-muted);
  line-height: 1.4;
  margin: 0;
}
.spl-alert {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-warning, #a16207);
  border-radius: var(--radius-sm, 6px);
  padding: 0.5rem 0.6rem;
  font-size: var(--text-sm, 0.875rem);
  background: var(--color-bg);
  flex: 0 0 auto;
  margin: 0;
}
.spl-alert-error { border-left-color: var(--color-danger, #b3261e); }
.spl-alert-text { flex: 1 1 auto; min-width: 0; }
.spl-alert-close {
  appearance: none;
  background: none;
  border: 0;
  color: var(--spl-muted);
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 0.1rem 0.25rem;
  border-radius: var(--radius-sm, 6px);
  font-family: inherit;
}
.spl-alert-close:hover { color: var(--color-text); }
.spl-alert-close:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }

.spl-bom { width: 100%; border-collapse: collapse; font-size: var(--text-sm, 0.875rem); }
.spl-bom th, .spl-bom td { padding: 0.35rem 0.4rem; border-bottom: 1px solid var(--color-border); text-align: left; }
.spl-bom td.spl-num, .spl-bom th.spl-num { text-align: right; white-space: nowrap; }
.spl-bom tfoot td { font-weight: 600; border-bottom: none; }

.spl-tray {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  padding: 0.4rem;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm, 6px);
  max-height: 6rem;
  overflow: auto;
}
.spl-tray-item {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  padding: 0.25rem 0.5rem;
  font-size: var(--text-xs, 0.75rem);
  background: var(--color-bg);
  cursor: pointer;
  color: var(--color-text);
  font-family: inherit;
}
.spl-tray-item:hover { border-color: var(--color-primary); }

.spl-first-run { display: grid; gap: var(--spl-gap); max-width: 46rem; margin: 0 auto; padding: clamp(1.5rem, 5vw, 3.5rem) 0; }
.spl-first-run .spl-title { font-size: var(--text-2xl, 1.6rem); }
.spl-first-run .spl-note { font-size: var(--text-sm, 0.875rem); }
.spl-choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: var(--spl-gap); }
.spl-choice {
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  padding: 1rem;
  background: var(--color-surface);
  text-align: left;
  cursor: pointer;
  color: var(--color-text);
  display: grid;
  gap: 0.3rem;
  align-content: start;
  font-family: inherit;
}
.spl-choice:hover { border-color: var(--color-primary); }
.spl-choice:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.spl-choice strong { font-size: var(--text-base, 1rem); }

/* Floating notes over the stage: the loading line, the degraded-items note, and
   the hint about what a click does. Pointer-events off so a note can never eat a
   drag that was meant for the room underneath it. */
.spl-coach {
  position: absolute;
  left: var(--spl-gap);
  bottom: var(--spl-gap);
  max-width: min(20rem, calc(100% - (var(--spl-gap) * 2)));
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  padding: 0.5rem 0.7rem;
  font-size: var(--text-sm, 0.875rem);
  box-shadow: var(--shadow-md, 0 4px 16px rgba(0,0,0,0.12));
  pointer-events: none;
}
.spl-stage-tools {
  position: absolute;
  right: var(--spl-gap);
  top: var(--spl-gap);
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
/* The strip that appears across the top of the plan while the room itself is
   being drawn or reshaped: what the pointer does now, and the way out. */
.spl-stage-bar {
  position: absolute;
  left: var(--spl-gap);
  top: var(--spl-gap);
  right: calc(var(--spl-gap) * 2 + 2.6rem);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  padding: 0.4rem 0.6rem;
  box-shadow: var(--shadow-sm, 0 1px 4px rgba(0,0,0,0.1));
}
.spl-stage-bar .spl-note { flex: 1 1 10rem; min-width: 0; }
.spl-stage-tools .spl-btn { background: var(--color-surface); box-shadow: var(--shadow-sm, 0 1px 4px rgba(0,0,0,0.1)); }

/* Eye height, down the left of the 3D view.
   Visible rather than a modifier key alone: a key nobody is told about is a
   feature nobody has, and on a phone there is no key to hold at all. Vertical
   because the thing it moves is vertical - a horizontal slider for height reads
   backwards no matter how it is labelled. */
.spl-eye {
  position: absolute;
  left: var(--spl-gap);
  top: var(--spl-gap);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  padding: 0.5rem 0.4rem;
  box-shadow: var(--shadow-sm, 0 1px 4px rgba(0,0,0,0.1));
}
.spl-eye-label {
  font-size: var(--text-xs, 0.75rem);
  color: var(--color-text-muted, var(--color-text));
  writing-mode: horizontal-tb;
}
/* writing-mode is the accessible way to stand a range control up: the browser
   keeps it a real slider with real arrow-key behaviour, where a rotate transform
   leaves the hit area lying on its side and the keys pointing the wrong way. */
.spl-eye-range {
  writing-mode: vertical-lr;
  direction: rtl;
  width: 1.4rem;
  height: 9rem;
  accent-color: var(--color-primary, var(--color-text));
}
.spl-eye-value {
  font-size: var(--text-xs, 0.75rem);
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
}
.spl-eye-presets { display: flex; flex-direction: column; gap: 0.2rem; }
.spl-eye-preset {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  border-radius: var(--spl-radius);
  padding: 0.15rem 0.4rem;
  font-size: var(--text-xs, 0.75rem);
  cursor: pointer;
}
.spl-eye-preset:hover { background: var(--color-surface-hover, var(--color-surface)); }
.spl-eye-preset:focus-visible { outline: 2px solid var(--color-primary, var(--color-text)); outline-offset: 1px; }
/* The room is short on height on a phone, and a control stood next to the
   coaching note is a control covering half the room. The presets carry the
   feature there; the slider is for the desk. */
@media (max-width: 40rem) {
  .spl-eye-range { height: 5rem; }
  .spl-eye-label { display: none; }
}

/* Saved viewpoints, across the top of the 3D view. A strip rather than a dialog:
   choosing an angle is something you do repeatedly while looking at the room. */
.spl-views {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  padding: 0.4rem var(--spl-gap);
  border-bottom: 1px solid var(--color-border);
}
.spl-views-label {
  font-size: var(--text-sm, 0.875rem);
  font-weight: 600;
  color: var(--color-text);
}
.spl-view-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  background: var(--color-surface);
}
.spl-view-go, .spl-view-more {
  border: 0;
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-sm, 0.875rem);
  padding: 0.25rem 0.5rem;
  cursor: pointer;
}
.spl-view-more { padding-inline: 0.35rem; border-left: 1px solid var(--color-border); }
.spl-view-go:hover, .spl-view-more:hover { background: var(--color-surface-hover, var(--color-surface)); }
.spl-view-go:focus-visible, .spl-view-more:focus-visible {
  outline: 2px solid var(--color-primary, var(--color-text));
  outline-offset: -2px;
}
.spl-view-name {
  border: 0;
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-sm, 0.875rem);
  padding: 0.25rem 0.5rem;
  width: 8rem;
  min-width: 0;
}
.spl-view-menu {
  position: absolute;
  top: calc(100% + 0.2rem);
  left: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  min-width: 8rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  box-shadow: var(--shadow-md, 0 4px 16px rgba(0,0,0,0.12));
  overflow: hidden;
}
.spl-view-menu button {
  border: 0;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  font-size: var(--text-sm, 0.875rem);
  padding: 0.4rem 0.6rem;
  cursor: pointer;
}
.spl-view-menu button:hover { background: var(--color-surface-hover, var(--color-surface)); }
.spl-view-danger { color: var(--color-danger, var(--color-text)); }
.spl-btn-sm { min-height: 2rem; padding: 0.2rem 0.6rem; font-size: var(--text-sm, 0.875rem); }

/* Which angle a photograph is taken from. */
.spl-photo-from {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  font-size: var(--text-sm, 0.875rem);
}
.spl-photo-from .spl-select { flex: 1 1 14rem; min-width: 0; }

/* The wall-length editor. A dialog rather than window.prompt: prompt is styled
   by the browser, blocked outright in some of them, and looks like the page has
   been hijacked. */
.spl-dialog-backdrop {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--color-text) 35%, transparent);
  padding: var(--spl-gap);
  z-index: 5;
}
.spl-dialog {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  padding: var(--spl-gap);
  display: grid;
  gap: 0.6rem;
  width: min(22rem, 100%);
  box-shadow: var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.2));
}
.spl-dialog h2 { margin: 0; font-size: var(--text-base, 1rem); font-weight: 600; }

/* The photograph, and the ones before it.
   Wider than the other dialogs on purpose: the whole point of asking for a
   picture of your office is to look at it, and a picture of an office shown two
   inches across is a swatch. Capped to the stage it sits in and scrolled inside
   itself, so a tall dialog on a short phone stage stays reachable rather than
   running off the bottom of it. */
.spl-dialog-wide { width: min(44rem, 100%); max-height: 100%; overflow: auto; }
.spl-photo {
  display: block;
  width: 100%;
  height: auto;
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
}
/* Somewhere for the eye to land while there is nothing to show yet, sized so the
   dialog does not jump a screen's worth when the first picture arrives. */
.spl-photo-empty {
  display: grid;
  place-items: center;
  min-height: 8rem;
  padding: var(--spl-gap);
  text-align: center;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg);
}
.spl-photo-strip { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.spl-photo-thumb {
  padding: 0;
  line-height: 0;
  overflow: hidden;
  cursor: pointer;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
}
.spl-photo-thumb img { display: block; width: 4.5rem; height: 3rem; object-fit: cover; }
.spl-photo-thumb[aria-pressed="true"] { border-color: var(--color-primary); }
.spl-photo-thumb:hover { border-color: var(--color-primary); }
.spl-photo-thumb:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }

.spl-launch {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

/* ---- Narrow screens ----------------------------------------------------
   Last, deliberately. A media query adds no specificity, so a phone rule
   written above an equally specific desktop rule quietly loses to it - which is
   how the overflow toggle ended up hidden on the one screen it exists for. */
@media (max-width: 1024px) {
  .spl-body {
    grid-template-columns: minmax(0, 1fr);
    /* The room gets the top of the screen and the panel the rest. Both scroll
       themselves, so neither can push the other off. */
    grid-template-rows: minmax(11rem, 42fr) minmax(0, 58fr);
  }
  /* While the room itself is being drawn or reshaped, the browse panel is
     nothing but a smaller canvas. On a phone that matters: half a screen is not
     enough to tap out the corners of an office. */
  .spl-body-editing { grid-template-rows: minmax(0, 1fr); }
  .spl-body-editing > .spl-side { display: none; }
}
@media (max-width: 640px) {
  .spl-root {
    --spl-gap: var(--space-2, 0.5rem);
    --spl-control-h: 2.5rem;
    min-height: 32rem;
  }
  .spl-bar { gap: 0.5rem; padding: 0.6rem; }
  /* Title and figures on one line: on a phone the toolbar is competing with the
     room for the screen, and three stacked rows of chrome before you see your
     own office is the wrong trade. */
  .spl-bar-heading {
    flex: 1 1 100%;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .spl-bar-heading .spl-title { font-size: var(--text-base, 1rem); }
  .spl-bar-spacer { display: none; }
  /* The view switcher is the thing people reach for most, so it gets a full
     row of its own with three equal targets rather than a place in the queue. */
  .spl-bar > .spl-tabs { flex: 1 1 100%; }
  .spl-bar > .spl-tabs .spl-tab { flex: 1 1 0; text-align: center; }
  .spl-bar-actions { flex: 1 1 100%; }
  .spl-bar-actions .spl-btn { flex: 1 1 auto; justify-content: center; }
  .spl-bar-actions .spl-more-toggle { display: inline-flex; flex: 0 0 auto; }
  /* Room, Undo, Redo and Print are one tap away rather than on screen: they are
     the ones a shopper reaches for occasionally, and the basket and Save are the
     ones the whole tool is pointed at. */
  .spl-bar-actions:not(.is-open) .spl-secondary { display: none; }
}

/* ---- Print --------------------------------------------------------------
   A printed plan is a document somebody hands to whoever signs the cheque, so
   it carries the room, the item list and the disclaimer - not a screenshot of
   an application with its toolbar in it. */
.spl-print-only { display: none; }
@media print {
  .spl-bar, .spl-side, .spl-coach, .spl-stage-tools, .spl-alert, .spl-dialog-backdrop,
  .spl-eye, .spl-views { display: none !important; }
  .spl-root { height: auto !important; min-height: 0 !important; display: block !important; }
  .spl-body { display: block !important; }
  .spl-stage { border: 1px solid #999; height: auto; page-break-inside: avoid; }
  /* Two things have to give for the plan to reach paper. The canvas carries an
     inline pixel size from the fit, wider than a sheet of A4, so on paper the
     room was cut off down the right-hand side. And its wrapper is absolutely
     positioned to fill the stage, which on a stage of automatic height collapses
     to nothing at all - the plan simply did not print. */
  .spl-plan-wrap { position: static !important; }
  .spl-stage canvas { width: 100% !important; height: auto !important; }
  .spl-print-only { display: block !important; }
  .spl-print-head { display: flex; justify-content: space-between; gap: 1rem; margin-bottom: 0.5rem; }
  .spl-print-head h2 { margin: 0; font-size: 1.1rem; }
  .spl-print-only .spl-bom { margin-top: 0.6rem; page-break-inside: auto; }
  .spl-print-only .spl-bom th, .spl-print-only .spl-bom td { border-bottom: 1px solid #ccc; }
  .spl-print-foot { margin-top: 0.5rem; font-size: 0.75rem; color: #444; }
}
`
}
