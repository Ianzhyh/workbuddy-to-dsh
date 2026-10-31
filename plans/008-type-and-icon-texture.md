# 008 — Type and icon texture pass

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7
- **Severity**: LOW (design foundation)
- **Category**: Craft / Typography / Icons
- **Estimated scope**: 1 file (`dashboard/public/style.css`), ~45 lines; no new dependencies

## Problem

The type system is already deliberate (three families, six-step scale, 400/600/700). The remaining "texture" gaps are:

1. **The sans stack stops at static Segoe UI on Windows.** Windows 11 ships **Segoe UI Variable**, which has optical sizing and renders UI text more evenly than the static family. The current stack never names it (`style.css:276-278`), so the page uses the older static face.
2. **Optical sizing is not enabled.** `font-optical-sizing: auto` is absent from `body`, so variable fonts cannot adapt their shapes to the 11–22px range.
3. **Heading leading is inherited from body.** `.brand-text h1` and `.panel h2` inherit `line-height: 1.6` from `body` (`style.css:480`), which is too loose for 16–18px display/title text. `.card .v` is 1.25; a 22px numeric anchor can be slightly tighter.
4. **Long secondary copy does not consistently use `text-wrap: pretty`.** `.panel .hint`, `.card .note`, and `.modelpick-note` already do; `.clientcard-note` and `.modal-body p` do not.
5. **Icon strokes are inconsistent.** The icon set is already a good Feather/Lucide-style 24×24 line set — **do not redraw it**. But `CARD_ICONS` (`index.html:2866-2881`) and several nav/action SVGs omit `stroke-linecap` / `stroke-linejoin`, so they render with butt caps and miter joins while the chevrons/back-to-top use round caps. Sizes are 13.5 / 14 / 15 / 16 / 20px with no 2px grid.

The user explicitly allows using a good existing icon set; this plan keeps the current Feather/Lucide-style set and only normalizes its rendering. No icon library is added; if a new icon is ever needed, take the Lucide path inline (same 24×24, 2px, round caps) rather than hand-drawing.

## Target

**Execution note (2026-10-31):** `.clientcard-note` already had `text-wrap: pretty` before this pass; only `.modal-body p` needed it. The rest of the plan was applied as written.

### 1. Sans stack: prefer Segoe UI Variable on Windows 11

```css
/* target — style.css:276 */
--font-sans: -apple-system, BlinkMacSystemFont,
             "Segoe UI Variable Text", "Segoe UI",
             "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei",
             "Noto Sans SC", Roboto, "Helvetica Neue", Arial, sans-serif;
```

Add a short comment above: no webfont (offline local tool); Segoe UI Variable Text is the Windows 11 optical-sized UI face; macOS uses `-apple-system`; older Windows falls back to static Segoe UI.

### 2. Body: enable optical sizing, keep the rest

```css
/* target — body, after font-variant-numeric */
font-optical-sizing: auto;
```

Do **not** add `font-synthesis: none` in this pass: the design relies on the browser mapping 600 to the nearest real weight (usually 700) in Chinese fonts that only ship 400/700. Verify text weight after the change.

### 3. Leading tokens + tighter display/title leading

Add next to the type scale (`style.css:302-317`):

```css
--lh-tight: 1.2;    /* 展示/标题：大字号收紧 */
--lh-prose: 1.7;    /* 面板说明、长段中文 */
```

Use them:

```css
body { line-height: 1.6; }                 /* keep the existing value */
.brand-text h1 { line-height: var(--lh-tight); }
.panel h2 { line-height: var(--lh-tight); }
.card .v { line-height: 1.15; }            /* was 1.25 */
.panel .hint { line-height: var(--lh-prose); } /* same value as today, tokenized */
```

The card value change is 22px × 0.10 = 2.2px per line; verify no CJK clipping for values like `运行 1 小时 30 分`.

### 4. Heading/copy wrapping

Add:

```css
.panel h2 { text-wrap: balance; }
.clientcard-note { text-wrap: pretty; }
.modal-body p { text-wrap: pretty; }
```

`.panel .hint`, `.card .note`, and `.modelpick-note` already have `pretty`; leave them.

### 5. Tracking: tighten display only

Change `--track-title` from `-0.012em` to `-0.016em` (`style.css:329`). This token is used by `.brand-text h1`, `.panel h2`, and `.card .v`. Do **not** change `--track-label` (0.01em): the 9-column model table width is tuned around it (`style.css:308-316`), and changing it can re-introduce wrapping.

### 6. Icon stroke consistency (no redraw, no new set)

Add one rule near the button/icon rules (after `button svg`, `style.css:959`):

```css
button svg,
.nav-tab svg,
.k-icon,
.brand-icon svg,
.back-to-top svg,
#logDrawer > summary svg {
  stroke-linecap: round;
  stroke-linejoin: round;
}
```

Change the two off-grid sizes:

```css
/* style.css:959 — target */
button svg { width: 14px; height: 14px; flex-shrink: 0; }

/* style.css:780 — target */
.nav-tab svg { width: 16px; height: 16px; opacity: 0.7; ... }
```

Keep the 16px card icon inside its 26px chip (`style.css:1397-1410`) and the 14px summary/back-to-top icons. If a new icon is needed, use a Lucide path inline (24×24 viewBox, stroke 2, round caps/joins) and keep `stroke="currentColor"`; do not add an icon package or a webfont.

## Repo conventions to follow

- The type stack is intentionally webfont-free (`style.css:259-275`); do not add a font package, CDN, or `@font-face`.
- The type scale is 11 / 12 / 13 / 16 / 18 / 22 with 400/600/700 (`style.css:293-327`); do not add new sizes. This pass changes leading/tracking/stack only.
- The 9-column model table is width-sensitive; never change label tracking or font family without re-running `test-data-typography.mjs` and checking table row heights.
- The icon set is already good: keep the existing Feather/Lucide-style paths; normalize caps/joins and sizes only. The user does not require hand-drawn icons.
- Colors must stay token-driven; the icon CSS rule must not set `stroke` color (it stays `currentColor`).

## Steps

1. Update `--font-sans` with `"Segoe UI Variable Text"` and the comment.
2. Add `font-optical-sizing: auto` to `body`.
3. Add `--lh-tight` / `--lh-prose`; apply to `.brand-text h1`, `.panel h2`, `.panel .hint`, and `.card .v`.
4. Add `text-wrap` rules for `.panel h2`, `.clientcard-note`, `.modal-body p`.
5. Change `--track-title` to `-0.016em`.
6. Add the icon caps/joins rule; change `button svg` to 14px and `.nav-tab svg` to 16px.
7. Add a one-line comment above `CARD_ICONS` in `index.html` (near line 2866) documenting the Feather/Lucide convention; do not change the paths.
8. Run Verification and compare screenshots.

## Boundaries

- Do NOT add a webfont, icon package, or dependency.
- Do NOT change the 11/12/13/16/18/22 scale, the 400/600/700 weight set, or `--track-label`.
- Do NOT replace or redraw the icon set; only normalize caps/joins/sizes.
- Do NOT change colors, backgrounds, borders, shadows, or gradients (the project forbids gradients).
- Do NOT change the sticky bar's height/padding in this plan; if the tighter brand/title leading changes the sticky bar height enough to cause overlap, STOP and report (the card composition plan 009 can adjust spacing).
- If the font stack change makes `test-data-typography` fail (non-tabular figures), revert only the stack addition and report; do not remove `font-variant-numeric`.
- If the code has drifted since d5a91c7, STOP and report.

## Verification

- **Mechanical**:
  - `npm run check:types`
  - `npm run lint`
  - `node tools/dev/test-data-typography.mjs` — all listed targets must stay tabular and numeric columns right-aligned; this is the guard against the variable font changing figures.
  - `node tools/dev/test-text-spacing.mjs` — no new clipping under 1.5× line-height / 0.12em tracking.
  - `node tools/dev/test-solid-contrast.mjs` and `node tools/dev/test-accent-schemes.mjs` — colors/contrast unchanged.
  - `node tools/dev/test-accent-icons.mjs` — icon colors still come from tokens; no hard-coded icon data-URI colors.
  - `node tools/dev/test-viewports.mjs` — no overflow at 1280/768/390.
- **Feel check**:
  - In DevTools → Elements → Computed → Rendered Fonts, the body/UI text should resolve to **Segoe UI Variable Text** on Windows 11 (or the next available fallback on other OSes).
  - Compare the brand lockup, panel titles, and metric values before/after at 100% and 200% zoom: headings should look tighter, not cramped; Chinese glyphs must not clip at the top/bottom.
  - Check the sticky bar at scrollY 0, 30 and 300: the brand/subtitle lockup should still be readable, and the compact state should not overlap the nav.
  - Check long panel hints and client notes: no orphan word or clipped descender; `text-wrap: pretty` should remove bad last-line breaks.
  - Inspect the card icons and nav/action icons at 200%: all strokes should have round caps/joins; no icon should look heavier/lighter than its neighbors.
  - Check light/dark and all five accent schemes: icon color still follows `currentColor`/tokens.
- **Done when**: the UI font resolves to Segoe UI Variable on Windows 11, heading leading is tighter, icons are consistently capped, all guards pass, and no layout clipping is introduced.
