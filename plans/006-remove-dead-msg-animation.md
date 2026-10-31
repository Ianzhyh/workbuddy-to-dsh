# 006 — Remove the dead message entrance animation

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7
- **Severity**: LOW
- **Category**: Purpose & frequency (dead code)
- **Estimated scope**: 1 file (`dashboard/public/style.css`), ~8 lines removed

## Problem

`#actionMsg` is static markup (`index.html:130`):

```html
<span class="msg" id="actionMsg"></span>
```

`setMsg()` (`index.html:2579-2586`) only changes its text and class:

```js
function setMsg(text, cls, title) {
  const el = $('actionMsg');
  el.textContent = text || '';
  el.className = 'msg' + (cls ? ' ' + cls : '');
  el.title = title || '';
  ...
}
```

The `.msg` rule declares an entrance animation (`style.css:837-854`):

```css
.msg { ... animation: msgFadeSlide 0.2s var(--ease); }
@keyframes msgFadeSlide {
  from { opacity: 0; transform: translateX(-6px); }
  to   { opacity: 1; transform: translateX(0); }
}
```

Because the element persists and the animation name never changes, the animation runs **once on page load** (with empty text) and never for the 52 actual `setMsg()` calls. Measured: calling `setMsg('测试反馈', 'good')` after load leaves `el.getAnimations()` empty. The intended "slide in" feedback does not exist; the text just swaps.

## Target

Remove the dead declaration and keyframes:

```css
/* target — .msg keeps layout/color only; feedback is the text + color class + live region */
.msg {
  color: var(--muted);
  font-size: var(--fs-label);
  margin-left: auto;
  font-weight: 400;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 440px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* no `animation` */
}
```

Delete `@keyframes msgFadeSlide` (`style.css:851-854`). Keep `.msg.err`, `.msg.good`, and the `.msg` layout exactly as they are.

Rationale: action feedback is frequent and should appear immediately; re-triggering a 200ms slide on every one of the 52 calls would add noise, and the live region already announces the result. If a future design wants a subtle change cue, use a one-shot WAAPI on **text change** with a reduced-motion guard; do not restore the persistent CSS animation.

## Repo conventions to follow

- The action message is part of the top bar, not a transient toast; the project uses inline feedback + `aria-live` (`announce()` in `setMsg`) rather than animated toasts.
- The reduced-motion blanket (`style.css:4078-4088`) is not relevant after removal; no new motion is introduced.
- Do not add a second feedback mechanism.

## Steps

1. In `style.css`, delete `animation: msgFadeSlide 0.2s var(--ease);` from `.msg`.
2. Delete the `@keyframes msgFadeSlide` block.
3. Confirm no other selector references `msgFadeSlide` (`grep -n "msgFadeSlide" dashboard/public`).
4. Run Verification.

## Boundaries

- Do NOT change `setMsg()` or the live-region announcement.
- Do NOT remove `.msg.err` / `.msg.good` color classes.
- Do NOT change the message layout (`max-width`, ellipsis, gap).
- Do NOT add a WAAPI replacement in this plan.
- No new dependencies.
- If the code has drifted since d5a91c7, STOP and report.

## Verification

- **Mechanical**:
  - `npm run check:types`
  - `npm run lint`
  - `node tools/dev/test-console-ui.mjs`
  - `node tools/dev/test-r3-alerts.mjs` (uses `setMsg` in the alert/action flows)
- **Feel check**:
  - Click a refresh/start/stop action; the message appears immediately with its color (no blank gap, no flash).
  - In DevTools Console, `setMsg('测试反馈','good')`; `document.getElementById('actionMsg').getAnimations()` must be `[]`.
  - Confirm the message is still announced to screen readers (`#liveRegion` text).
- **Done when**: the message text/color behavior is unchanged and the dead animation/keyframes are gone.
