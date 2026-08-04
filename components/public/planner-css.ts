// One stylesheet for the whole planner, injected once by the root component.
//
// Semantic tokens throughout - no hex anywhere in the chrome, so the planner
// follows whatever theme the site is wearing and passes AA in light and dark
// without a second set of rules. The only literal colours in this module are
// inside the 3D scene, where they are materials rather than chrome.
//
// Layout target: full-bleed inside <main>. Module public pages always render
// inside the site header and footer on this platform - there is no chrome-free
// route - so "full screen" means the viewport minus the sticky header, and the
// nav stays where a shopper mid-purchase wants it.
export const PLANNER_HEADER_ALLOWANCE = '76px'

export function plannerCss(): string {
  return `
.spl-root {
  --spl-gap: var(--space-3, 0.75rem);
  --spl-radius: var(--radius-md, 10px);
  display: grid;
  grid-template-rows: auto 1fr;
  gap: var(--spl-gap);
  min-height: calc(100vh - ${PLANNER_HEADER_ALLOWANCE});
  color: var(--color-text);
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
}
.spl-bar-spacer { flex: 1 1 auto; }
.spl-title {
  font-size: var(--text-lg, 1.1rem);
  font-weight: 600;
  margin: 0;
  color: var(--color-text);
}
.spl-sub { color: var(--color-text-muted); font-size: var(--text-sm, 0.875rem); }

.spl-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 22rem;
  gap: var(--spl-gap);
  align-items: stretch;
  min-height: 0;
}
@media (max-width: 1024px) {
  .spl-body { grid-template-columns: minmax(0, 1fr); }
  .spl-side { max-height: 26rem; }
}

.spl-stage {
  position: relative;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  overflow: hidden;
  min-height: 26rem;
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
  overflow: auto;
  min-height: 0;
}

.spl-tabs { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.spl-tab {
  appearance: none;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-muted);
  border-radius: var(--radius-sm, 6px);
  padding: 0.35rem 0.7rem;
  font-size: var(--text-sm, 0.875rem);
  cursor: pointer;
}
.spl-tab[aria-selected="true"] {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-primary-contrast, #fff);
}
.spl-tab:focus-visible, .spl-btn:focus-visible, .spl-input:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.spl-btn {
  appearance: none;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  border-radius: var(--radius-sm, 6px);
  padding: 0.4rem 0.75rem;
  font-size: var(--text-sm, 0.875rem);
  cursor: pointer;
}
.spl-btn:hover:not(:disabled) { border-color: var(--color-primary); }
.spl-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.spl-btn-primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-primary-contrast, #fff);
}
.spl-btn-danger { color: var(--color-danger, #b3261e); border-color: var(--color-danger, #b3261e); }

.spl-input, .spl-select {
  width: 100%;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  padding: 0.4rem 0.5rem;
  font-size: var(--text-sm, 0.875rem);
}
.spl-field { display: grid; gap: 0.25rem; }
.spl-field label { font-size: var(--text-xs, 0.75rem); color: var(--color-text-muted); }
.spl-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; }

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
}
.spl-card:hover { border-color: var(--color-primary); }
.spl-card img { width: 3rem; height: 3rem; object-fit: contain; border-radius: 4px; background: var(--color-surface); }
.spl-card-name { font-size: var(--text-sm, 0.875rem); line-height: 1.25; }
.spl-card-meta { font-size: var(--text-xs, 0.75rem); color: var(--color-text-muted); }

.spl-badge {
  display: inline-block;
  font-size: var(--text-xs, 0.75rem);
  padding: 0.05rem 0.35rem;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}
.spl-badge-3d { border-color: var(--color-primary); color: var(--color-primary); }
.spl-badge-warn { border-color: var(--color-warning, #a16207); color: var(--color-warning, #a16207); }

.spl-note {
  font-size: var(--text-xs, 0.75rem);
  color: var(--color-text-muted);
  line-height: 1.4;
}
.spl-alert {
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-warning, #a16207);
  border-radius: var(--radius-sm, 6px);
  padding: 0.5rem 0.6rem;
  font-size: var(--text-sm, 0.875rem);
  background: var(--color-bg);
}
.spl-alert-error { border-left-color: var(--color-danger, #b3261e); }

.spl-bom { width: 100%; border-collapse: collapse; font-size: var(--text-sm, 0.875rem); }
.spl-bom th, .spl-bom td { padding: 0.35rem 0.4rem; border-bottom: 1px solid var(--color-border); text-align: left; }
.spl-bom td.spl-num, .spl-bom th.spl-num { text-align: right; }
.spl-bom tfoot td { font-weight: 600; border-bottom: none; }

.spl-tray {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  padding: 0.4rem;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm, 6px);
}
.spl-tray-item {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  padding: 0.2rem 0.45rem;
  font-size: var(--text-xs, 0.75rem);
  background: var(--color-bg);
  cursor: pointer;
  color: var(--color-text);
}

.spl-first-run { display: grid; gap: var(--spl-gap); max-width: 42rem; margin: 0 auto; padding: 2rem 0; }
.spl-choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: var(--spl-gap); }
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
}
.spl-choice:hover { border-color: var(--color-primary); }
.spl-choice strong { font-size: var(--text-base, 1rem); }

.spl-coach {
  position: absolute;
  left: var(--spl-gap);
  bottom: var(--spl-gap);
  max-width: 20rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--spl-radius);
  padding: 0.6rem 0.75rem;
  font-size: var(--text-sm, 0.875rem);
  box-shadow: var(--shadow-md, 0 4px 16px rgba(0,0,0,0.12));
}

.spl-launch {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

@media print {
  .spl-bar, .spl-side, .spl-coach, .spl-tabs { display: none !important; }
  .spl-body { grid-template-columns: 1fr; }
  .spl-stage { border: none; }
  .spl-print-only { display: block !important; }
}
.spl-print-only { display: none; }
`
}
