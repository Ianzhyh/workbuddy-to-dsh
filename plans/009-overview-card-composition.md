# 009 — Overview card composition

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7
- **Severity**: LOW (visual design)
- **Category**: Card system / Composition
- **Estimated scope**: 2 files (`dashboard/public/style.css`, `dashboard/public/index.html`), ~80 lines

## Problem

The overview is structurally one long stack of large flat panels. The metric cards are the only strongly card-like elements; the panels have no header/body separation, the metric cards' footnotes do not share a baseline, and the usage panel is one large block containing four different things (metric cards, trend chart, credit ranking, model table) with no card boundaries.

The design system already has the right ingredients — warm paper surfaces, 1px borders, no static shadows, no gradients (`style.css:28-57`, `137-158`). This plan uses them, not new decoration.

Observed specifics:

- `.panel` is a 20px-radius flat surface (`style.css:1459-1476`); `.panel h2` is just a flex title with `margin: 0 0 6px` (`style.css:1494-1511`). There is no header rule under the title.
- `.card` uses `padding: 16px 18px` but no flex column or min-height (`style.css:1347-1364`); `.card .note` is `margin-top: 8px` (`style.css:1449-1456`), so notes sit wherever the content ends instead of aligning at the card bottom.
- The usage panel emits `buildTrendChart(buckets)`, `renderCreditRanking(u.models)`, and a raw table into the same `#usageBox` (`index.html:4420-4448`) with no card wrappers. The ranking has its own `<h3 class="sub-h">积分排行（按模型）</h3>` (`index.html:4277`); the trend and the table have no headings.

## Target

### A. Panel header becomes a card header

Add after the `.panel h2` rule (`style.css:1494-1511`):

```css
/* 卡片头：标题/控件与正文之间用一条发丝线分开（不是阴影，也不加渐变） */
.panel > h2 {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}
```

Visual check note: `--border-subtle` was tried first and is almost invisible on `--panel` (both themes). Use `--border`, the same token as the panel's outer hairline; it reads as a header rule without becoming a heavy divider.

Change `.panel-tools`'s negative top margin (`style.css:1539`) so the controls do not crowd the new rule:

```css
/* target */
.panel-tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  row-gap: 8px;
  margin: 0 0 var(--space-4);
}
```

The h2's font/serif/size/weight/spacer/row-gap stay unchanged. The divider uses `--border`, the same hairline token as the panel edge; `--border-subtle` was tried first and is effectively invisible on `--panel` in both themes.

### B. Metric cards share a baseline

Change `.card` (`style.css:1347-1364`) to:

```css
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
  box-shadow: var(--shadow-card);
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 108px;
}
```

Change `.card .note` (`style.css:1449-1456`) to:

```css
.card .note {
  color: var(--muted);
  font-size: var(--fs-label);
  margin-top: auto;
  padding-top: 8px;
  line-height: 1.5;
  text-wrap: pretty;
  word-break: break-word;
}
```

The existing `.card .k { margin-bottom: 8px; }` and `.card .v` line-height stay. Cards without a note keep the value at the top and breathe at the bottom.

### C. Usage panel becomes three cards

Add a new `.usage-card` block near the usage styles (after `.chart-legend`, before `.sub-h`, around `style.css:2570`):

```css
/*
 * 用量面板内部的三块（趋势 / 积分排行 / 按模型明细）各自成卡。
 * 表面用 --panel + 1px 边框，与指标卡同一套语言；不加阴影、不加渐变。
 * 不用 overflow:hidden —— 表格自己滚动，卡片不能再裁内容。
 */
.usage-card {
  padding: 14px 16px 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.usage-card + .usage-card { margin-top: var(--space-4); }
.usage-card > .sub-h { margin: 0 0 10px; }
.usage-card .chart { margin: 0; }
.usage-card .rank { margin-bottom: 0; }
.usage-card .tablewrap {
  border: 0;
  background: transparent;
  box-shadow: none;
  border-radius: var(--radius-sm);
}
```

The first card needs no top margin: the hint above it already has `margin: 0 0 var(--space-4)`.

In `renderUsage()` (`index.html:4424-4427`), wrap the trend chart and the ranking:

```js
  // target — trend card
  html += '<div class="usage-card"><h3 class="sub-h">趋势</h3>'
    + buildTrendChart(buckets) + '</div>';

  // target — ranking card (renderCreditRanking already returns its own <h3 class="sub-h">)
  const ranking = renderCreditRanking(u.models);
  if (ranking) html += '<div class="usage-card">' + ranking + '</div>';
```

For the model table (`index.html:4429-4447`), wrap the existing block with the usage card and add a heading. Keep every table header/row line unchanged:

```js
  if (u.models.length) {
    // 明细表在窄屏下会宽于容器：必须放进可横向滚动的壳里，否则整页横向溢出
    html += '<div class="usage-card"><h3 class="sub-h">按模型明细</h3>'
      + '<div class="tablewrap" style="max-height:340px">'
      + '<table><thead><tr><th>模型</th>...' // 现有的表头/行原样保留
      ...
      + '</tbody></table></div></div>';
  } else {
    html += '<div class="usage-card"><h3 class="sub-h">按模型明细</h3>'
      + '<div class="empty">这段时间没有调用。</div></div>';
  }
```

The `tr.pickrow` wiring after `box.innerHTML = html;` (`index.html:4452-4459`) stays; the wrapper does not change the descendants.

### D. i18n entries for the two new headings

The usage panel is translated through the DOM layer, so add exact dictionary entries next to the existing usage entry (`index.html:1102`, near `'积分排行（按模型）'`):

```js
'趋势': 'Trend',
'按模型明细': 'Per-model details',
```

Run `node tools/dev/check-i18n-coverage.mjs --check '趋势' '按模型明细'` after adding them.

## Repo conventions to follow

- The card language: `--panel` surface + 1px `--border` + `--radius` (12px), no static shadows, no gradients (`style.css:28-57`, `137-158`). The usage cards follow the metric cards, not the floating layers.
- Do not use the drawer shadow (`--shadow-drawer`) or `--shadow-lift` on static cards.
- Keep the 20px panel radius and the 12px card radius; the nested radius must stay smaller than the outer one (`style.css:1462-1467`).
- Use existing spacing tokens (`--space-4` = 16px); do not introduce a new spacing scale.
- The i18n DOM layer matches complete text nodes; the new headings must be standalone text nodes (the `<h3>` should contain only the string), and the dictionary entries must match exactly.
- The usage table selectors in tests are descendant-based (`#usageBox svg.chart`, `.rank-row`, `tr.pickrow`); wrappers are safe, but do not rename those classes.

## Steps

1. `style.css`: add `.panel > h2` header rule; change `.panel-tools` margin to `0 0 var(--space-4)`.
2. `style.css`: add `display:flex; flex-direction:column; min-height:108px;` to `.card`; change `.card .note` to `margin-top:auto; padding-top:8px`.
3. `style.css`: add the `.usage-card` block (and its child overrides) near the usage chart styles.
4. `index.html`: wrap the trend chart, ranking, and model table in `.usage-card`; add the "趋势" and "按模型明细" h3 headings; pass the ranking through a local `const ranking` so the empty case adds no empty card.
5. `index.html`: add the two i18n dictionary entries.
6. Run Verification and compare screenshots before/after.

## Boundaries

- Do NOT add shadows, gradients, colored card fills, or a left accent bar. The panel divider is the only new line.
- Do NOT change colors, surfaces, border tokens, or radii.
- Do NOT change the chart/ranking/table data logic, sorting, or selectors.
- Do NOT change the tab logic (`data-section`), the request filter linkage, or the usage export.
- Do NOT add a card grid wrapper around the overview panels; the vertical stack stays.
- Do NOT change the `.cards` intro animation or the `.settled` behavior from plan 001.
- If the code has drifted since d5a91c7, STOP and report.

## Verification

- **Mechanical**:
  - `npm run check:types`
  - `npm run lint`
  - `node tools/dev/check-i18n-coverage.mjs --check '趋势' '按模型明细'`
  - `node tools/dev/test-r10-charts.mjs`
  - `node tools/dev/test-usage-chart-modes.mjs`
  - `node tools/dev/test-trend-week.mjs`
  - `node tools/dev/test-data-typography.mjs` — the usage table/numbers must stay tabular and right-aligned.
  - `node tools/dev/test-text-spacing.mjs` — the new `.usage-card` must not add clipping; the table must still scroll.
  - `node tools/dev/test-viewports.mjs` — 1280 / 768 / 390.
- **Feel check**:
  - At 1280px, the overview panel headers should read as a title strip with a hairline under it; the `panel-tools` controls should not touch the line.
  - The 8 status cards should have equal heights in a row; their notes should sit on the bottom edge; hovering still lifts the card.
  - The usage panel: metric cards, then a "趋势" card, a "积分排行（按模型）" card, and a "按模型明细" card. Borders should read as three cards, not nested boxes; no double border around the table; the table still scrolls inside its card and the sticky header still works.
  - Switch to 390px: the cards stack; the table scrolls horizontally; no page-level horizontal scrollbar; the card headings do not wrap awkwardly.
  - Toggle dark mode and all accent schemes: the dividers and card borders remain visible but quiet; no shadows appear.
  - Switch tabs and refresh: the new wrappers do not break the panel show/hide or the row-click filter.
- **Done when**: the overview reads as a set of cards with clear headers, metric notes align, the usage subcards do not double-border or clip, i18n coverage passes, and all guards are green.
