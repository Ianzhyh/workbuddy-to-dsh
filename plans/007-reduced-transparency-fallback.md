# 007 — Reduced-transparency fallback for the sticky bar

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7
- **Severity**: LOW
- **Category**: Accessibility / Material
- **Estimated scope**: 1 file (`dashboard/public/style.css`), ~10 lines added

## Problem

The sticky bar is the only `backdrop-filter` surface on the page (`style.css:546-560`):

```css
.top-bar-sticky.is-scrolled {
  background: rgba(250, 249, 245, 0.88);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  border-bottom-color: var(--border);
  box-shadow: 0 4px 20px rgba(60, 50, 38, 0.06);
  padding: 8px 0 6px;
  margin-bottom: var(--space-3);
}
[data-theme="dark"] .top-bar-sticky.is-scrolled {
  background: rgba(20, 20, 20, 0.88);
  border-bottom-color: var(--border);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45);
}
```

There is no `prefers-reduced-transparency` handling anywhere (`grep -n "prefers-reduced-transparency" dashboard/public` returns nothing). Users who ask the OS for less transparency still get a blurred, see-through header while content scrolls under it.

## Target

Add a solid fallback after the dark-theme rule. The dark selector must be included because it has higher specificity than `.top-bar-sticky.is-scrolled` and would otherwise keep the translucent background:

```css
/*
 * 降低透明度偏好：吸顶栏改回实色，不再让内容从下面透出来。
 * 两个选择器都要列：深色主题那条特异性更高，只写 .top-bar-sticky.is-scrolled
 * 会被它盖住（背景仍是 rgba(20,20,20,.88)）。
 * `--bg` 在两种主题下都等于页面底色，正好是"不透明的同色条"。
 */
@media (prefers-reduced-transparency: reduce) {
  .top-bar-sticky.is-scrolled,
  [data-theme="dark"] .top-bar-sticky.is-scrolled {
    background: var(--bg);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}
```

Keep the border/shadow/padding/height transitions; only the material changes. The normal (no-preference) appearance must stay exactly as it is.

## Repo conventions to follow

- The sticky bar's material is documented at `style.css:538-545`: it is the only place `backdrop-filter` earns its cost. Do not add backdrop filters elsewhere.
- Use the existing `--bg` token rather than a hard-coded white/black; it flips with `[data-theme="dark"]`.
- The reduced-motion block at `style.css:4078` handles motion, not transparency; keep this new query separate and near the sticky bar.

## Steps

1. In `style.css`, immediately after the `[data-theme="dark"] .top-bar-sticky.is-scrolled` rule (currently ending at line 560), add the media query above.
2. Confirm the selector order and specificity: the media-query rule comes after both base rules.
3. Run Verification.

## Boundaries

- Do NOT change the normal translucent background, blur radius, or shadow.
- Do NOT add a second `backdrop-filter` anywhere.
- Do NOT change the sticky bar's scroll threshold or height.
- Do NOT change `--bg` in either theme.
- No new dependencies.
- If the code has drifted since d5a91c7, STOP and report.

## Verification

- **Mechanical**:
  - `npm run check:types`
  - `npm run lint`
  - `node tools/dev/test-accent-schemes.mjs` — the header text contrast must not regress.
  - `node tools/dev/test-viewports.mjs` — layout unchanged at 1280/768/390.
- **Feel check**:
  - Normal mode: scroll past 28px; the header is still translucent + blurred, content shows through.
  - Emulate reduced transparency (CDP `Emulation.setEmulatedMedia` with `{ name: 'prefers-reduced-transparency', value: 'reduce' }`, or the browser's Rendering panel if available): scroll past 28px; the header must be a solid `--bg` color with no blur. Verify in both light and dark themes.
  - Check the computed style: `getComputedStyle(document.querySelector('.top-bar-sticky.is-scrolled')).backdropFilter` is `none` and `backgroundColor` is the solid `--bg` value under the preference; `blur(16px)` normally.
- **Done when**: the reduced-transparency preference produces a solid header in both themes; the normal material is unchanged.
