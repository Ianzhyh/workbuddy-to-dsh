# 011 — Spatial detail pass: chart, keyboard, drawer heights, drag settle

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7 (base; applied after 001–010)
- **Severity**: LOW (spatial / interaction detail)
- **Category**: Spatial consistency / Keyboard / Interruptibility
- **Estimated scope**: 2 files (`dashboard/public/index.html`, `dashboard/public/style.css`); no test changes required

## Why this pass

Plan 010 covered hover/contrast/press/tooltip/chat/accent. This pass covers the four larger details that were intentionally left for a later round:

1. **Usage chart updates** — the SVG was rebuilt every poll with no transition.
2. **Custom dropdown keyboard navigation** — mouse/Tab worked, but Arrow/Home/End did not.
3. **Model detail row and log drawer heights** — the content animated, the container jumped.
4. **Account drag release** — the rows snapped to the new order after drop.

Skill mapping: Apple §1 response / §7 spatial consistency (container height and chart continuity), Apple §5 flexibility / agency (keyboard path), Emil §4 interruptibility (the row/drawer/FLIP settle), Emil §6 accessibility (keyboard/focus).

## Changes

### 1. Chart update fade — only when data or presentation changes

`renderUsage()` now computes a signature and only adds `.chart-in` when the trend actually changed:

```js
let lastTrendSig = '';
...
const trendSig = JSON.stringify([trendGran, trendMetric, trendKind, buckets]);
const trendChanged = trendSig !== lastTrendSig;
lastTrendSig = trendSig;
html += '<div class="usage-card' + (trendChanged ? ' chart-in' : '') + '">...'
```

CSS:

```css
.usage-card.chart-in .chart-legend,
.usage-card.chart-in .chart { animation: chartIn 0.22s var(--ease); }
@keyframes chartIn {
  from { opacity: 0.55; transform: translateY(2px); }
  to   { opacity: 1; transform: none; }
}
```

A 20-second poll with identical data adds no class; a data/granularity/metric/shape change fades once. This avoids the replay class fixed in plan 001.

### 2. Dropdown keyboard navigation

- `ddOpen(dd, { focus = false } = {})` focuses the selected (or first) item when opened from the keyboard.
- Trigger keys: Enter / Space / ArrowDown open with focus; when already open, ArrowDown/Enter focus the selected item; Escape closes.
- Menu keys: ArrowUp/ArrowDown wrap, Home/End jump, Escape closes and returns focus to the trigger.
- Selecting an item returns focus to the trigger (the focused option is removed when the menu closes).
- `focusout` on the `.dd` closes the menu when Tab moves focus outside it.

`ddOpen` remains non-focusing for mouse opens (click), so the existing pointer flow and tests are unchanged.

### 3. Model detail row height

- Opening a model detail measures the `.detail-body` height, sets it to 0 with its padding and the cell's vertical padding collapsed, forces one layout (`void body.offsetHeight`), then transitions height/padding to the content height over 220ms. After 280ms the inline styles are cleared and the row returns to auto.
- Closing animates the body height to 0 and the cell padding to 0 over 160ms, then removes the `<tr>` at 190ms.
- A `WeakMap` (`detailMotionTimers`) cancels the open cleanup timer when a close starts, so the open timer cannot reset the closing row to auto mid-exit.
- `prefers-reduced-motion` skips the height animation; the row appears/disappears instantly.
- Opening a different model still removes the previous row immediately (only the same-row close animates); no two detail rows coexist.

Verified heights: open `2 → 54 → 89 → 108 → … → 137`, close `137 → 67 → 32 → … → 2` before removal.

### 4. Log drawer height

`#logDrawer` is the only static `<details>` (the manual/clients details are created later). A summary click now prevents the native toggle and runs a measured height animation:

- Open: lock the drawer to its closed height, set `open = true`, load the log, then after `loadLog()` resolves animate to `scrollHeight` (220ms) and release to auto. Waiting for the load avoids opening to the placeholder height and then jumping when the log arrives.
- Close: animate to the summary height + border (220ms), then set `open = false` (which also stops the 3s log timer).
- Programmatic `open = true/false` (tests, refresh paths) bypasses the animation and keeps the native behavior.
- The summary remains the focus target; the arrow rotation and existing content fade are untouched.

Verified heights: open `49 → 115 → 157 → … → 218`, close `218 → 151 → 108 → … → 49`.

### 5. Account drag release FLIP

The drag itself stays native HTML5 DnD (the keyboard path is the existing Up/Down buttons). On drop, `wireAccountDrag` captures each row's rect before the reorder, awaits the reorder/render, then animates each moved row from its old offset to 0 over 220ms (WAAPI, repo `--ease`). Reduced motion skips the FLIP. No custom pointer capture or spring library was introduced.

**Execution note (2026-10-31):** the native real-drag path was replaced by the Pointer Events implementation in plan 012. The native handlers remain only as a synthetic-event fallback for `test-account-order`; the FLIP helper from this plan is reused by the pointer path.

## Verification

- `npm run check:types`, `npm run lint`: pass.
- `node tools/dev/run-ui-tests.mjs`: **38 / 38** pass after this batch (including `test-r6-detail`, `test-r5-observability`, `test-focus-ring`, `test-account-order`, `test-r10-charts`, `test-trend-week`, `test-usage-chart-modes`, `test-dropdowns`, `test-ui-kit`).
- Runtime probes:
  - Chart: first render `chart-in = 1`, identical re-render `0`, metric change `1`.
  - Keyboard: ArrowDown opens with focus on the selected item; ArrowDown moves to the next; Escape closes and returns focus to the trigger.
  - Model detail: intermediate body heights on open/close (above); row removed after close.
  - Log drawer: intermediate heights on open/close (above); programmatic open unchanged.
  - Account drag test: the drag submission order remains `[C, A, B]`; the FLIP only adds motion after the drop.

## Not done / deliberately scoped

- **Full direct-manipulation account drag** — picked up in plan 012: Pointer Events, 1:1 tracking, velocity handoff, momentum projection, spring and rubber-band. The Up/Down buttons remain the keyboard path; native DnD remains only for synthetic tests.
- **Chart geometry interpolation** (morphing bars/line between datasets) was not attempted; the fade is a deliberate, cheap continuity cue with a data guard.
- **Log drawer reopen during its close** is not supported; the user can click again after the ~220ms exit. Adding reverse-from-current handling would need the same generation-token approach as the dropdowns/modals.
- **Log content growing after the open animation** (e.g., first 3s poll adds lines) can still change the drawer height after the settle; the content is capped and the log is a dev tool.
