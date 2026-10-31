# 010 — Interaction detail pass

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7 (base; applied together with plans 001–009)
- **Severity**: LOW (detail / accessibility)
- **Category**: Interaction details / Accessibility
- **Estimated scope**: 2 files (`dashboard/public/index.html`, `dashboard/public/style.css`); no test changes

## Why this pass exists

The first nine plans covered the audit's main categories (purpose/frequency, easing/duration, physicality/origin, interruptibility, performance, accessibility, cohesion, missed opportunities) and Apple's response / interruptibility / spatial consistency / materials / typography sections. This pass covers the remaining **small but real** details that were visible in the code but not worth a HIGH/MEDIUM plan:

| Skill section | Detail applied here |
| --- | --- |
| Apple §1 Response, §10 Tap | Press feedback on the custom dropdown trigger/items; stronger, more honest press scales on checkbox/chip/quick-pill |
| Apple §5 Flexibility, Emil §6 Accessibility | `@media (hover: none)` removes hover translation/scale on touch; color feedback remains |
| Apple §7 Spatial consistency, Emil §4 Interruptibility | Accent-color menu gets the same 120ms exit as the other dropdowns; reopening during exit is safe |
| Apple §14 Reduced motion / contrast | `prefers-contrast: more`: stronger hairlines, solid sticky bar, solid focus outline |
| Emil §2 Purpose/frequency (tooltips) | Hover intent: first tooltip waits 300ms; subsequent tooltips within 800ms show immediately |
| Apple §1 Agency, §4 Interruptibility | Chat streaming follows the bottom only when the user is already near it; the user's scroll position is preserved |

**Not applied, deliberately:** springs, velocity handoff, momentum projection and rubber-banding. The console has no custom 2D drag/throw gesture — the only drag (account reorder) is native HTML5 DnD, which has no pointer-velocity hook. Adding a spring library or rewriting the drag would not improve this UI and would violate the project's dependency/scope rules. Likewise, audio/haptic feedback and scroll-edge masks are not appropriate for this local desktop console.

## Changes

### 1. Touch hover gating (`style.css`)

```css
@media (hover: none) {
  button:hover, .brand-icon:hover, .card:hover, .card:hover .k-icon,
  .acct:hover, .quick-pill:hover, .back-to-top:hover, .back-to-top:hover svg,
  #refreshBtn:hover svg, #themeToggle:hover svg.ic-on,
  #accentToggle:hover .accentdot { transform: none; }
}
```

Color/border/background feedback stays; `:active` press feedback stays.

### 2. High-contrast preference (`style.css`)

```css
@media (prefers-contrast: more) {
  :root, [data-theme="dark"] {
    --border: var(--border-strong);
    --border-subtle: var(--border-strong);
  }
  .top-bar-sticky.is-scrolled,
  [data-theme="dark"] .top-bar-sticky.is-scrolled {
    background: var(--bg);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  :focus-visible {
    outline: 2px solid var(--border-focus) !important;
    outline-offset: 2px;
  }
}
```

The `box-shadow` focus ring remains; the solid outline is the fallback when a high-contrast system overrides shadows.

### 3. Press feedback (`style.css`)

- `.dd-trigger:active { transform: scale(0.98); }`
- `.dd-item:active, .accentitem:active { background: var(--panel-hover); }`
- `input[type="checkbox"]:active` `scale(0.9)` → `scale(0.95)`
- `.modelpick-chip:active` `scale(0.94)` → `scale(0.96)`
- `.quick-pill:active` `scale(0.99)` → `scale(0.98)`

### 4. Accent menu exit (`style.css` + `index.html`)

- CSS: `.accentmenu.closing { animation: dd-pop-out 0.12s var(--ease) both; }`
- `openAccentMenu()` clears the close timer, removes `.closing`, restores `aria-expanded`, removes `inert`.
- `closeAccentMenu()` adds `.closing` + `aria-hidden` + `inert`, waits for `animationend` (fallback 200ms), then sets `hidden`.
- The finish checks `.closing` first, so reopening during the 120ms exit does not hide the reopened menu. The button treats a `.closing` menu as closed.

### 5. Chat follow (`index.html`)

`renderChat(forceScroll = false)` records `follow` and `prevTop` **before** replacing `innerHTML`:

```js
const follow = forceScroll || (out.scrollHeight - out.scrollTop - out.clientHeight < 48);
const prevTop = out.scrollTop;
...
out.scrollTop = follow ? out.scrollHeight : prevTop;
```

`sendChat()` calls `renderChat(true)` for the new user/assistant turn; streaming chunks call `renderChat()` and only follow when the reader is already within 48px of the bottom. Scrolling up during streaming no longer gets yanked back.

### 6. Tooltip hover intent (`index.html`)

- `tipSchedule(el, opts)` waits 300ms on the first tooltip; if a tooltip was shown within 800ms, the next shows immediately.
- `tipHide()` and `pointerout` clear the pending timer, so leaving before 300ms never pops a stale tooltip.
- Keyboard `focusin` still shows immediately.

## Verification

- `npm run check:types`, `npm run lint`: pass.
- `node tools/dev/run-ui-tests.mjs`: **38 / 38** pass (including accent schemes, UI kit tooltip, chat, dropdowns, card motion, text spacing, viewports).
- Runtime probes:
  - `prefers-contrast: more` matches; panel border resolves to `--border-strong` (`rgb(61, 59, 52)` in dark); sticky bar `background: rgb(20,20,20)`, `backdrop-filter: none`.
  - Accent item click → `.accentmenu.closing` present, `hidden: true` after 180ms.
  - Chat: after scrolling to top, a streaming render keeps `scrollTop = 0`; at the bottom, it follows to `scrollHeight − clientHeight` (867px in the probe).
  - Touch emulation (`Emulation.setTouchEmulationEnabled`) makes `(hover: none)` match; the CSS rule is present. CDP cannot force a `:hover` pseudo-state, so the transform removal is verified by rule inspection rather than a simulated hover.
- The first four remaining detail candidates from this pass — log-drawer/model-detail row height, usage-chart update transition, and arrow-key navigation inside the custom dropdown — were picked up in plan 011. The last one (a full Pointer Events + spring account reorder) remains a larger interaction rewrite.
