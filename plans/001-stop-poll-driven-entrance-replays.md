# 001 — Stop poll-driven entrance replays

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7
- **Severity**: HIGH
- **Category**: Purpose & frequency / Interruptibility
- **Estimated scope**: 2 files (`dashboard/public/index.html`, `dashboard/public/style.css`), ~35 lines

## Problem

The console polls every 20 seconds (`index.html:9700-9706`). Several poll handlers rebuild DOM whose children carry entrance animations, so those animations replay on every poll. The overview `#cards` grid already has an explicit one-shot guard; the usage cards, the alert bar and the request notice do not.

### 1. Usage cards re-stagger every 20 seconds

`renderUsage()` builds `.cards` grids with `card()` (`index.html:4367`, `index.html:4382`) and replaces the whole panel with `box.innerHTML = html;` (`index.html:4451`). `loadUsage()` is in the 20-second poller, so this happens every cycle.

The CSS applies the entrance to every `.cards > .card` (`style.css:1324`):

```css
.cards > .card { animation: cardRise 0.34s var(--ease) backwards; }
.cards.settled > .card { animation: none; }
```

`#cards` (overview) is settled once in `renderCards` (`index.html:5994-6005`), but the `.cards` grids inside `#usageBox` are never settled.

Measured with the headless harness: after `renderUsage()` the six usage cards start `cardRise` again with delays `0s / 0.045s / 0.09s / 0.135s / 0.18s`.

### 2. Alert bar re-slides every 20 seconds

`renderAlerts()` (`index.html:3152`) always rebuilds the bar:

```js
// index.html:3267-3272 — current
items.sort((x, y) => x.sev - y.sev);
if (!items.length) { bar.hidden = true; bar.innerHTML = ''; return; }

bar.hidden = false;
bar.innerHTML = items.map((it, i) => ...)
```

`.alert` carries `animation: slideDown 0.22s var(--ease);` (`style.css:1275`). Every poll creates new `.alert` nodes, so the animation restarts.

Measured: with the bridge stopped (the un-dismissable "桥未运行" alert), `animationstart` fired at **348ms** and again at **20163ms** for both visible alerts; the alert DOM was swapped at 20167ms.

### 3. Request failure notice re-slides every 20 seconds

`renderRequests()` (`index.html:4635`) rebuilds `#reqBox` with a notice string (`index.html:4666`, inserted at `index.html:4718`). `.notice` also has `animation: slideDown 0.22s var(--ease);` (`style.css:1625`).

Measured: `#reqBox .notice` fired `animationstart` at **20217ms** after the poll rebuilt it.

### Why this matters

The page looks like it refreshed itself (or glitched) every 20 seconds. It also fights the intentional data-change cue: `valueBump` on changed readings (`style.css:4052`) is supposed to be the only periodic motion. A user watching the dashboard cannot tell "the page re-rendered" from "something changed".

## Target

### A. Usage cards settle after the first paint

Add immediately after `box.innerHTML = html;` (`index.html:4451`):

```js
  box.innerHTML = html;
  /*
   * 用量面板每 20 秒整体重绘（loadUsage -> renderUsage）。入场编排只属于首屏：
   * 这里直接落到静止态，否则六张卡每轮都会重新 cardRise。
   * 总览 #cards 的首屏编排仍保留（见 renderCards 的 cardsIntroPlayed）。
   */
  box.querySelectorAll('.cards').forEach((g) => g.classList.add('settled'));
```

`.cards.settled > .card { animation: none; }` (`style.css:1330`) already exists; no CSS change is needed. The usage panel's first fill is still covered by the panel-level `box-in` animation (`initPanelFadeIn`, `index.html:2632-2653`).

### B. Alert bar only rebuilds when the alert set changes

Replace the sort/empty/rebuild block (`index.html:3267-3272`) with:

```js
  items.sort((x, y) => x.sev - y.sev);

  /*
   * 20 秒轮询会重复调用本函数。告警条只在「告警集合真的变了」时重建；
   * 否则每轮都重新插入节点，slideDown 会每 20 秒重播一次。
   * 签名只含展示内容与按钮文案；这里的 action.run 都是调用当前页面函数，
   * 不会捕获过期数据，所以集合不变时跳过是安全的。
   */
  const alertSig = items.map((it) => [
    it.sev, it.cls, it.text,
    it.action ? it.action.label : '',
    it.dismiss ? it.dismiss.label : '',
  ].join('|')).join('\n');
  if (bar.dataset.alertSig === alertSig) return;
  bar.dataset.alertSig = alertSig;

  if (!items.length) { bar.hidden = true; bar.innerHTML = ''; return; }

  bar.hidden = false;
  // 文案全部过 escapeAttr：错误原文、账号等都可能含 HTML
  bar.innerHTML = items.map((it, i) => ...)
```

Keep the rest of `bar.innerHTML` and the button wiring unchanged. When the set genuinely changes (new failure count, token threshold, bridge state), the alert still animates in.

### C. The request notice appears without an entrance animation

Add after the `.notice` block (`style.css:1625-1627`):

```css
/*
 * 「最近请求」面板每 20 秒整体重绘一次；提示条跟着重建，入场动画会周期性重播。
 * 它不是用户动作的结果，静止出现即可。其它 .notice（插件登录 / 客户端接入）
 * 是状态或用户动作触发的，保留原来的 slideDown。
 */
#reqBox .notice { animation: none; }
```

## Repo conventions to follow

- The one-shot `.settled` pattern is already established: `style.css:1330` and `index.html:5994-6005`. Copy its comment style and use the class on the `.cards` parent, not on each card.
- Do not add a new timer for the usage cards. The overview already owns the only staggered entrance; the usage panel is a data panel, and a timer would re-introduce a race with fast view switches.
- Use `dataset` for the alert signature; no new global variable.
- Keep the `backwards` fill mode and `nth-child` delays untouched; the overview intro must keep working.

## Steps

1. In `index.html`, in `renderUsage()`, insert the `box.querySelectorAll('.cards')...` block immediately after `box.innerHTML = html;` (currently line 4451), before the `tr.pickrow` event wiring.
2. In `index.html`, in `renderAlerts()`, replace the three-line sort/empty/rebuild block with the signature-guarded version above. Verify the `bar.innerHTML` mapping and the two `querySelectorAll` wiring blocks are still below it.
3. In `style.css`, add the `#reqBox .notice { animation: none; }` rule and comment after the `.notice.hidden` rule (currently line 1627).
4. Run the checks in Verification. Do not modify anything else.

## Boundaries

- Do NOT touch `renderCards()`, `#cards`, `cardsIntroPlayed`, or the 45ms stagger.
- Do NOT remove `cardRise` or `slideDown` globally; other components still use them.
- Do NOT change alert text, severity sorting, action labels, or the alert wiring.
- Do NOT change request table rendering, filtering, or the `#reqBox` scroll preservation.
- Do NOT add new dependencies.
- If the current code no longer matches the excerpts above (drift since d5a91c7), STOP and report instead of improvising.

## Verification

- **Mechanical**:
  - `npm run check:types`
  - `npm run lint`
  - `node tools/dev/test-card-motion.mjs` — the overview 8-card stagger and hover lift must still pass.
  - `node tools/dev/test-r3-alerts.mjs` — alert rendering/actions.
  - `node tools/dev/test-r10-charts.mjs` and `node tools/dev/test-trend-week.mjs` — the usage panel still renders.
  - `node tools/dev/test-text-spacing.mjs` — the first `.cards` and the usage panel must not gain new clipping.
- **Feel check**:
  - Open the console with the bridge stopped so the un-dismissable "桥未运行" alert is visible. Leave the overview untouched for 25 seconds. The alert must not slide in again at the 20-second mark; the usage cards must not rise again.
  - In DevTools Console, after the page settles, run `renderAlerts();` twice. Set a `data-test` attribute on one alert, call `renderAlerts()` with no state change, and confirm the attribute is still there (the node was not replaced). Run `renderUsage();` and confirm no `.card` inside `#usageBox` has a `cardRise` animation.
  - Open the Animations panel and set playback to 10%. On first load, the `#cards` stagger should still play once; `slideDown` should only run when the alert set changes.
  - Toggle `prefers-reduced-motion: reduce` in the Rendering panel: the alerts and cards still appear/disappear, but without movement.
- **Done when**:
  - A 25-second observation of the overview shows zero new `animationstart` events for `.alert`, `#usageBox .card`, and `#reqBox .notice`.
  - The first load still shows the one-shot `#cards` stagger.
  - All mechanical checks pass.
