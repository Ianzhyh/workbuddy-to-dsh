# 005 — Add exit animations to dropdowns and modals

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7
- **Severity**: LOW
- **Category**: Interruptibility / Spatial consistency
- **Estimated scope**: 2 source files + 2 test files, ~70 lines

## Problem

Both overlay types animate in, then disappear instantly:

### 1. Custom dropdowns

`ddClose()` removes the menu immediately (`index.html:561-567`):

```js
function ddClose(dd) {
  dd.classList.remove('open', 'drop-up');
  const menu = dd.querySelector('.dd-menu');
  if (menu) menu.remove();
  const trig = dd.querySelector('.dd-trigger');
  if (trig) trig.setAttribute('aria-expanded', 'false');
}
```

The menu enters with `dd-pop` / `dd-pop-up` (`style.css:1903-1912`, 160ms), but the exit is a `remove()`. The open and close paths are spatially inconsistent: the menu appears from the trigger but vanishes from existence.

### 2. Confirm / prompt modal

`appConfirm()` and `appPrompt()` both do this in `done()` (`index.html:2713-2718`, `index.html:2783-2788`):

```js
const done = (val) => {
  document.removeEventListener('keydown', onKey, true);
  scrim.remove();
  if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch { /* ... */ } }
  resolve(val);
};
```

The scrim fades in over 160ms and the dialog scales/slides in over 200ms (`style.css:878-929`), but the close is an instant `remove()`. The user presses "取消" and the dialog teleports away.

## Target

### A. Dropdown exit

**CSS** — add after `.dd.drop-up .dd-menu` (`style.css:1906-1910`):

```css
.dd-menu.closing { animation: dd-pop-out 0.12s var(--ease) both; }
.dd.drop-up .dd-menu.closing { animation-name: dd-pop-out-up; }
@keyframes dd-pop-out {
  from { opacity: 1; transform: none; }
  to   { opacity: 0; transform: translateY(-6px) scale(0.98); }
}
@keyframes dd-pop-out-up {
  from { opacity: 1; transform: none; }
  to   { opacity: 0; transform: translateY(6px) scale(0.98); }
}
```

The exit mirrors the enter (`dd-pop` starts at `translateY(-6px) scale(0.98)`; `dd-pop-up` starts at `+6px`), so the menu leaves toward the trigger it came from. `transform-origin` stays top-left / bottom-left.

**JS** — replace `ddClose` / `ddCloseAll` and adjust `ddOpen` (`index.html:561-611`):

```js
function ddClose(dd, { animate = true } = {}) {
  const menu = dd.querySelector('.dd-menu');
  const trig = dd.querySelector('.dd-trigger');
  dd.classList.remove('open');
  if (trig) trig.setAttribute('aria-expanded', 'false');
  if (!menu) { dd.classList.remove('drop-up'); return; }
  if (!animate) { menu.remove(); dd.classList.remove('drop-up'); return; }

  menu.classList.add('closing');
  menu.setAttribute('aria-hidden', 'true');
  menu.style.pointerEvents = 'none';
  const finish = () => {
    menu.remove();
    // 同一 dd 可能在退场期间被重新打开；只有仍处于关闭态时才清 drop-up
    if (!dd.classList.contains('open')) dd.classList.remove('drop-up');
  };
  menu.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 200);
}

function ddCloseAll(opts) {
  for (const dd of document.querySelectorAll('.dd.open')) ddClose(dd, opts);
}
```

In `ddOpen()` (`index.html:574-611`), after `ddCloseAll();` add:

```js
  // 打开新菜单时，旧菜单立即移除：否则同一个 dd 里会短暂存在两个 .dd-menu，
  // 后续 ddClose 可能删错节点（退场中的那个）
  ddCloseAll({ animate: false });
  dd.querySelectorAll('.dd-menu').forEach((m) => m.remove());
```

(Replace the existing bare `ddCloseAll();` in `ddOpen` with these two lines.)

**Tests** — the dropdown test asserts immediate removal (`tools/dev/test-dropdowns.mjs:183`):

```js
menuGone: !dd.querySelector('.dd-menu'),
```

Change to:

```js
menuGone: !dd.querySelector('.dd-menu:not(.closing)'),
```

The closing node is inert (`aria-hidden`, `pointer-events: none`) and is treated as "gone" for interaction purposes.

### B. Modal exit

**CSS** — add after the modal rules (`style.css:927-929`):

```css
.modal-scrim.closing {
  animation: modalScrimOut 0.14s var(--ease) forwards;
  pointer-events: none;
}
.modal-scrim.closing .modal {
  animation: modalOut 0.14s var(--ease) forwards;
}
@keyframes modalScrimOut { to { opacity: 0; } }
@keyframes modalOut {
  to { opacity: 0; transform: translateY(-6px) scale(0.985); }
}
```

The exit mirrors `modalIn` (`translateY(-6px) scale(0.985)` → none); the scrim fades. The `.modal-scrim.closing` rule is more specific than `.modal`'s entry animation, so it overrides it.

**JS** — add one helper above `appConfirm()` and use it in both `done()` functions:

```js
function dismissScrim(scrim) {
  if (!scrim || !scrim.isConnected) return;
  scrim.classList.add('closing');
  scrim.setAttribute('inert', '');
  const finish = (e) => {
    if (e && e.target !== scrim) return;
    scrim.remove();
  };
  scrim.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 220); // 后台标签页/降级时兜底；scrim 已 inert，不会挡住操作
}
```

In `appConfirm()`'s `done()` (`index.html:2713-2719`) and `appPrompt()`'s `done()` (`index.html:2787-2793`), replace `scrim.remove();` with `dismissScrim(scrim);`. The focus restore and `resolve()` stay synchronous; the dialog is non-interactive (`inert`, `pointer-events: none`) during the 140ms fade.

**Tests** — the confirm test asserts immediate removal (`tools/dev/test-confirm-modal.mjs:62`, `117`, `128`, `134`, `142`). Change every `.modal-scrim` count that means "an open modal" to `.modal-scrim:not(.closing)`. For example:

```js
// before
if (await q(cdp, `document.querySelectorAll('.modal-scrim').length`) === 0) pass('Esc 关闭弹窗');
// after
if (await q(cdp, `document.querySelectorAll('.modal-scrim:not(.closing)').length`) === 0) pass('Esc 关闭弹窗');
```

Apply the same selector to the other close assertions and to the `open` snapshot count. Add `await sleep(180)` after opening a new modal if the test's immediate snapshot can see the previous closing scrim.

**Execution note (2026-10-31):** only `test-dropdowns.mjs` needed the `:not(.closing)` selector. `test-confirm-modal.mjs` already sleeps 320ms after each close (and 250ms after the backdrop click), which covers the 140ms exit; it passed unchanged. Do not edit the modal-test selectors unless a future change shortens those waits.

## Repo conventions to follow

- The overlay material is already defined: dropdown `dd-pop` / `dd-pop-up` at `style.css:1911-1912`, modal `modalIn` / `modalScrimIn` at `style.css:922-929`. The exit must mirror those paths (spatial consistency, Apple §7).
- Use `var(--ease)`; durations stay short (120ms menu, 140ms modal) and under the 300ms UI budget.
- The reduced-motion blanket (`style.css:4078-4088`) compresses these CSS animations to 0.01ms; the `animationend`/fallback removes the node. Do not add WAAPI.
- Keep the `inert`/`pointer-events: none` closing state so a fading overlay never blocks a click.
- This plan does not touch the accent-color menu (`#accentMenu`), which toggles `hidden` directly and has a different close path; leave it as is.

## Steps

1. `style.css`: add the dropdown exit CSS after `.dd.drop-up .dd-menu` (1906-1910).
2. `style.css`: add the modal exit CSS after the `.modal` reduced-motion block (927-929).
3. `index.html`: replace `ddClose`/`ddCloseAll`; update `ddOpen` to remove old menus before appending.
4. `index.html`: add `dismissScrim()` above `appConfirm`; replace `scrim.remove()` in both `done()` functions.
5. `tools/dev/test-dropdowns.mjs`: change line 183 to `.dd-menu:not(.closing)`.
6. `tools/dev/test-confirm-modal.mjs`: change the open/close `.modal-scrim` counts to `:not(.closing)` as described.
7. Run Verification.

## Boundaries

- Do NOT delay `resolve()` / state changes; only the visual removal is delayed.
- Do NOT add exits to the accent menu (`#accentMenu`) in this plan.
- Do NOT change dropdown positioning, widths, or `drop-up` detection.
- Do NOT change modal content, focus trap, or button behavior.
- Do NOT add new dependencies or WAAPI.
- If the code/tests have drifted since d5a91c7, STOP and report.

## Verification

- **Mechanical**:
  - `npm run check:types`
  - `npm run lint`
  - `node tools/dev/test-dropdowns.mjs`
  - `node tools/dev/test-confirm-modal.mjs`
  - `node tools/dev/test-account-alias.mjs`
  - `node tools/dev/test-i18n.mjs`
- **Feel check**:
  - Open a dropdown (normal and near the bottom, `drop-up`). Close with Esc, outside click, and item selection. The menu should fade toward the trigger in 120ms; the trigger arrow rotates back immediately; no flash of the old menu.
  - Reopen the same dropdown during its 120ms exit: exactly one menu should be present after opening; selecting an item must close the **new** menu.
  - Open a confirm dialog; press Esc, cancel, confirm, and click the scrim. The dialog fades upward and the scrim fades over 140ms; focus returns to the trigger immediately; the page is clickable immediately after the fade.
  - Repeat with `prefers-reduced-motion: reduce`: both overlays must disappear instantly with no movement and no stuck/inert overlay.
  - DevTools Animations panel at 10%: the exit transforms mirror the entrance (down menu exits upward, up menu exits downward, modal exits upward).
- **Done when**: both overlays animate out along their entry path, interaction is immediate, the tests pass, and no overlay can get stuck.
