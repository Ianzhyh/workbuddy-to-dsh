# Plugin frontend pass + transform-safe account drag

Scope: `dsh-plugin/lib/client.js` (single-file React bundle injected into the dsh settings panel). The console had already gone through plans 001–012; this pass brings the plugin to the same motion/detail baseline and replaces the native HTML5 account drag with a Pointer Events implementation that survives the host's transformed modal layer.

## What changed

### Motion / CSS

- Replaced the remaining `transition: all` declarations (6) with explicit property lists; every animated surface is now transform/color/shadow only.
- Removed the decorative quota gradient; the quota block uses the platform module background token.
- Added a scoped reduced-motion blanket (`prefers-reduced-motion: reduce`) for `.wb-root`, `wb-chat-*` and `.wb-turn-cost` — no bare `*` selector, because this stylesheet is injected globally into the host. Spinner falls back to a 2s cycle; press transforms are disabled.
- Added `@media (hover: none)` gating for hover-only transforms, so touch taps do not leave a row shrunk.
- `prefers-contrast: more` keeps borders readable; controls keep their focus rings.

### Requests table

- Headers are localized words (`输入` / `输出`) instead of lowercase `in` / `out`.
- Model cell: empty model renders `—` (was blank); the cell is marked `data-wb-raw` so the model name and its `title` are never auto-translated.
- Failure cell is split into a base line (`失败 HTTP 429 · code …`) and a smaller kind line (upstream/rate-limit/…); both are `white-space: nowrap` with a minimum width, so rows no longer wrap into three lines and change height.
- Chart axes format fractional ticks (`0.5`, `1.5`) instead of rounding them into duplicates (`2, 2, 1, 1, 0`).

### Dropdown keyboard / a11y

- Trigger: Enter/Space/Arrow keys open the menu; focus returns to the trigger after selection.
- Menu: `role="listbox"`, items `role="option"` + `aria-selected`; Arrow/Home/End/Escape navigate; focusout closes when focus leaves the widget; `:focus-visible` ring added.

### Account drag (Pointer Events)

- Native DnD removed from rows/handles (`draggable: false`); up/down buttons remain the keyboard path.
- 1:1 tracking with a 4px threshold, placeholder, FLIP for the other rows (`220ms`, skip under reduced motion), 8px hysteresis for the live target, 120ms velocity sampling and `0.998` momentum projection, critically damped spring (`k=320`, `c=36`), rubber-band at the list edges (`0.55`), Esc / pointercancel revert.
- **Positioning is relative to the list, not the viewport.** The host renders the settings page inside a transformed layer; `position: fixed` inherits that containing block and the dragged row jumps sideways. The row is now `position: absolute` inside the account list (the list gets `position: relative` for the duration of the drag), with `top` computed from the row's layout slot.
- **Scroll-aware tracking.** On every pointer move and on any captured `scroll` (window + document), the translate is recomputed from `list.top + slot − list.scrollTop`, so scrolling the settings page a little keeps the row under the pointer instead of leaving it behind with the content.
- Safety: a mouse `pointermove` with `buttons === 0` (release lost outside the window) cancels; window `blur` cancels; finalize tolerates a mid-drag React re-render by skipping the insert when the placeholder/row is disconnected, then always cleans up.
- Esc and pointercancel restore the original position; the order POST happens only when the final index differs.

### Tests

- New `dsh-plugin/tests/panel-drag.mjs` (+ `npm run panel:drag`, wired into `panel:check`): CDP mouse drag inside a transformed ancestor, asserts row left/width stay aligned, the row stays under the pointer while the page scrolls 40px, Esc cancels without a request, and the drop posts the whole order (`POST body === final DOM order`).
- `tools/dev/test-account-order.mjs`: added the same transformed-ancestor alignment and mid-drag scroll assertions for the console copy.
- `dsh-plugin/tests/i18n-data.test.mjs`: model cell regex updated for the `—` fallback and `data-wb-raw` marker.

## Verification (2026-10-31)

- `npm run lint` — pass.
- `npm run test:plugin` — **254 / 254**.
- `npm run panel:check` — panel render (9 tabs, charts, tables, no page errors), panel drag (**pass: no drift, scroll-follow, Esc rollback, whole-order POST**), panel i18n (zh/en, no residual Chinese, 71 baseline strings restored).
- `npm run test:ui` — **38 / 38**, including the transform + scroll drag cases.
- `npm run check:types` — pass.

## Runtime note

The dsh profile links `node_modules/dsh-plugin-workbuddy` directly to this repo, but the client bundle is evaluated when the app/window starts. The running app keeps the version it loaded at launch; reopen the settings window or restart dsh to see this pass. No repack is needed for the dev symlink; npm/GitHub installs need the usual upgrade.
