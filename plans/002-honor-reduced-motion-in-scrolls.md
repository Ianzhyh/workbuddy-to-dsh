# 002 — Honor reduced motion in JS smooth scrolls

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 1 file (`dashboard/public/index.html`), 2 edits + comments

## Problem

The stylesheet already has a complete reduced-motion strategy: every transition/animation is compressed, and `scroll-behavior` is forced to `auto` (`style.css:4078-4088`):

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    ...
    scroll-behavior: auto !important;
  }
}
```

Two JS call sites pass an **explicit** `behavior: 'smooth'`, which overrides the CSS and ignores the user's preference.

### 1. Back to top

```js
// index.html:9630-9634 — current
if (btn) {
  btn.onclick = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
}
```

Measured with `prefers-reduced-motion: reduce` emulated: clicking `#backToTop` at `scrollY = 2000` still animated; the sampled `scrollY` went `2000 → 1998 → 1990 → … → 12` over 40 frames (about 670ms), while the computed `scroll-behavior` was `auto`.

### 2. Rank-row → requests jump

```js
// index.html:4560-4564 — current
if (reqModelFilter && !opts.noScroll) {
  const box = $('reqBox');
  if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
```

The same explicit `behavior: 'smooth'` bypasses the reduced-motion rule. Clicking a model row in the usage table or a bar in the credit ranking triggers this.

The tab switcher already does it correctly (`index.html:9568`: `window.scrollTo(0, 0)` with a comment explaining that the CSS/reduced-motion rules handle the timing); use that as the exemplar.

## Target

### 1. Back to top

```js
// target
if (btn) {
  btn.onclick = () => {
    /*
     * 不传 behavior：让 html { scroll-behavior: smooth } 决定。
     * reduced-motion 的全局兜底会把 scroll-behavior 压成 auto（style.css 第 18 节）；
     * 显式传 'smooth' 会绕过它（实测 reduce 下仍从 2000 滑到 0）。
     */
    window.scrollTo(0, 0);
  };
}
```

### 2. Rank-row / table-row jump

```js
// target
if (reqModelFilter && !opts.noScroll) {
  const box = $('reqBox');
  // 默认 behavior:'auto' 跟随 CSS：正常模式平滑，reduce 下瞬间到位
  if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start' });
}
```

No JS `matchMedia` branch is needed: both calls fall back to the CSS rule that already handles the preference. This keeps the reduced-motion policy in one place.

## Repo conventions to follow

- The reduced-motion blanket lives at the end of the stylesheet (`style.css:4078`) and is documented as "只关动不关变"; do not add a second, competing policy.
- The tab switcher at `index.html:9560-9568` is the exemplar: it uses `window.scrollTo(0, 0)` and relies on the CSS rule, with a comment explaining the reduced-motion behavior.
- Keep comments in the existing Chinese style; explain the why (explicit smooth overrides CSS).
- No new helper, no new dependency, no `matchMedia` cache needed.

## Steps

1. In `index.html`, replace the `btn.onclick` body in `initBackToTop()` (currently lines 9630-9634) with `window.scrollTo(0, 0);` and the comment above.
2. In `index.html`, remove `, behavior: 'smooth'` from the `box.scrollIntoView(...)` call in `setReqModelFilter()` (currently line 4563) and add the one-line comment.
3. Run the checks in Verification.

## Boundaries

- Do NOT remove or change `html { scroll-behavior: smooth; }` (`style.css:462-465`).
- Do NOT change `switchTab()`'s `window.scrollTo(0, 0)`.
- Do NOT touch the sticky bar scroll handler or the back-to-top show/hide threshold.
- Do NOT add a global `scroll-behavior` override.
- No new dependencies.
- If the line numbers/code have drifted since d5a91c7, STOP and report.

## Verification

- **Mechanical**:
  - `npm run check:types`
  - `npm run lint`
  - `node tools/dev/test-r1-linkage.mjs` — the ranking/table → request filter linkage still works.
  - `node tools/dev/test-console-ui.mjs` and `node tools/dev/test-viewports.mjs` — no scroll/layout regressions.
- **Feel check**:
  - Normal mode: click "回顶部" from a deep scroll; it should still glide smoothly to the top (the CSS `scroll-behavior: smooth` path).
  - Reduced mode: DevTools → Rendering → `prefers-reduced-motion: reduce`; click "回顶部" from `scrollY = 2000`; it must jump to `0` within 1–2 frames, not glide. Repeat for a model-row click that jumps to `#reqBox`; it must jump instantly.
  - Turn reduced motion off again and confirm both are smooth.
  - Check `getComputedStyle(document.documentElement).scrollBehavior` is `smooth` normally and `auto` under reduce.
- **Done when**: both call sites animate normally and jump instantly under reduce; no other scroll behavior changes.
