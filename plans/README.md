# Console motion & visual refinement plans

Audit of `dashboard/public` at commit `d5a91c7`. These plans are self-contained: each one includes the current code, the exact target, steps, boundaries and a feel-check. The audit was read-only; **all plans were applied and verified on 2026-10-31** — see "Execution result" below.

## Plans

| # | Plan | Severity | Track | Status |
| --- | --- | --- | --- | --- |
| 001 | [Stop poll-driven entrance replays](001-stop-poll-driven-entrance-replays.md) | HIGH | Motion | DONE |
| 002 | [Honor reduced motion in JS smooth scrolls](002-honor-reduced-motion-in-scrolls.md) | MEDIUM | Motion / a11y | DONE |
| 003 | [Single animation path for model chips](003-single-animation-path-for-model-chips.md) | MEDIUM | Motion / perf | DONE |
| 004 | [Settle the tab pill without overshoot](004-settle-tab-pill.md) | LOW | Motion polish | DONE |
| 005 | [Add exit animations to dropdowns and modals](005-add-overlay-exits.md) | LOW | Motion polish | DONE |
| 006 | [Remove the dead message entrance animation](006-remove-dead-msg-animation.md) | LOW | Cleanup | DONE |
| 007 | [Reduced-transparency fallback for the sticky bar](007-reduced-transparency-fallback.md) | LOW | A11y | DONE |
| 008 | [Type and icon texture pass](008-type-and-icon-texture.md) | LOW | Visual foundation | DONE |
| 009 | [Overview card composition](009-overview-card-composition.md) | LOW | Visual composition | DONE |
| 010 | [Interaction detail pass](010-interaction-detail-pass.md) | LOW | Detail / a11y | DONE |
| 011 | [Spatial detail pass: chart, keyboard, drawer heights, drag settle](011-spatial-detail-pass.md) | LOW | Spatial / keyboard | DONE |
| 012 | [Pointer Events account drag](012-pointer-account-drag.md) | MEDIUM | Direct manipulation / physics | DONE |
| 013 | [Plugin frontend pass + transform-safe account drag](013-plugin-frontend-drag.md) | MEDIUM | Plugin parity / drag | DONE |

## Execution result (2026-10-31)

All nine plans plus the two detail passes (010 and 011) and the account drag rewrite (012) are implemented in the working tree:

- Source: `dashboard/public/index.html`, `dashboard/public/style.css`; test: `tools/dev/test-dropdowns.mjs` (the `.closing` selector).
- `npm run check:types` and `npm run lint` pass.
- `node tools/dev/run-ui-tests.mjs`: **38 / 38** pass, including after the detail pass.
- Detail pass (010): touch hover gating, `prefers-contrast: more`, stronger press feedback, accent-menu exit, chat follow-only-near-bottom, tooltip hover intent. Runtime probes confirmed the contrast tokens/glass, accent close, scroll preservation/follow, and touch `(hover: none)` media.
- Spatial detail pass (011): data-guarded chart fade, dropdown Arrow/Home/End navigation with focus return, animated model-detail row and log-drawer heights, and a FLIP settle on native account drag. Probes: chart `1/0/1`, detail `2→54→…→137`, log `49→218→49`, keyboard focus/return, full suite 38/38.
- Account drag rewrite (012): Pointer Events with 1:1 tracking, placeholder + FLIP, live target with hysteresis, velocity projection (`0.998`), a critically-damped spring (`k=320/c=36`), rubber-band boundaries, Esc/pointercancel revert, and an `isConnected` guard against mid-drag re-renders. Real-mouse probe: fixed row + placeholder during drag; POST order `[b, c, a]` after dropping A past C. `test-account-order` now covers both native-synthetic and Pointer paths; full suite 38/38.
- Plugin frontend pass + drag (013): explicit transition lists, scoped reduced-motion blanket, quota gradient removed, Requests table layout/model/result fixes, dropdown keyboard support, and a Pointer Events account drag in the plugin. The drag is positioned relative to the account list (not `fixed`) so the host's transformed settings layer cannot shift it, and recomputes on any captured scroll so the row stays under the pointer while the page scrolls. New `panel-drag.mjs` (wired into `panel:check`) asserts transform-safe alignment, scroll-follow, Esc rollback and whole-order POST; the console test gained the same transform/scroll cases. `test:plugin` 254/254, `test:ui` 38/38, `panel:check` pass.
- Runtime probes:
  - 22 seconds with the bridge stopped: zero alert / usage-card / request-notice entrance replays after the fixes.
  - Chip click: one WAAPI transform + color transitions; no CSS `chipPop` keyframes, no per-chip forced reflow; reduced-motion skips the WAAPI.
  - `prefers-reduced-motion`: back-to-top from `scrollY = 2000` jumps to `0` in the first frame.
  - `prefers-reduced-transparency`: sticky bar is solid (`blur: none`).
  - Dropdown/modal exits render and remove the closing node (~120 / 140ms); the modal focus restore and close assertions still pass.
  - The two new usage headings translate (`Trend` / `Per-model details`).
- Visual: light/dark screenshots checked at 1440×1000. Panel headers use a visible `--border` hairline; metric-card notes align at the card bottom; the usage panel reads as three cards (趋势 / 积分排行 / 按模型明细); the sticky compact header still works.
- Changes are **uncommitted**; review with `git diff` before committing.

## Recommended execution order

1. **001** — stop the 20-second replay of usage cards, alerts and the request notice. This is the highest-leverage feel fix and is independent of everything else.
2. **003** — remove the duplicated chip animation and the per-chip forced reflow; also makes the chip pop respect reduced motion.
3. **002** — make the two JS smooth-scroll paths obey `prefers-reduced-motion`.
4. **008 → 009** — visual foundation first (font stack/optical sizing/leading, icon caps), then the overview card composition. 009 reads better after 008's leading tokens; screenshots and spacing checks should run in this order.
5. **004 / 006 / 007** — small independent polish items.
6. **005** — overlay exits; it touches two test files and is best done after the motion fixes above.
7. **010** — interaction detail pass; apply after 001–009 (it assumes the plan-001/005 behavior) and re-run the full UI suite.
8. **011** — spatial detail pass; apply after 010. The chart fade uses the same signature principle as 001; the drawer/row animations assume the overlay/timing patterns from 005.
9. **012** — Pointer Events account drag; apply last. It replaces the real native-drag path and keeps the native handlers only for synthetic tests.

## Dependencies and interactions

- **001 and 009** both touch `renderUsage()`: 001 adds a `settled` line immediately after `box.innerHTML = html;`; 009 wraps the chart/ranking/table HTML. Apply 001 first, then 009, and re-run the usage tests.
- **008 and 009** both touch `style.css` typography/card spacing. Do 008 first; 009's screenshots assume the tighter leading. If 008 changes the sticky bar height enough to cause overlap, stop (both plans' boundaries say so) rather than compensating in 009.
- **004, 005, 007** all touch `style.css` but different selectors; they can be applied independently. If more than one is applied in one pass, re-run the visual tests once at the end.
- **005** changes overlay close timing; its plan includes the required updates to `tools/dev/test-dropdowns.mjs` and `tools/dev/test-confirm-modal.mjs`. Do not apply the JS/CSS without the test updates.
- The cards' one-shot `#cards` stagger, the 240ms tab-section slide, and the View Transitions for theme/language are **intentionally preserved**; none of these plans removes them.

## Baseline facts used by the plans

- Stack: plain HTML/CSS/vanilla JS; no motion library. One easing token `--ease: cubic-bezier(0.16, 1, 0.3, 1)`; `--transition-fast` 160ms / `--transition-normal` 240ms.
- Existing safeguards: explicit transition property lists (no `transition: all`), no `scale(0)` entrances, correct popover origins, press feedback on pointer-down, a global `prefers-reduced-motion` blanket (`style.css:4078-4088`), and View Transitions for theme/language.
- Verified non-issues: the existing `node tools/dev/audit-motion.mjs` "配置块伸缩不平滑" failure is a test artifact (it samples a `.codeblock` inside the closed "手动接入" `<details>`; a visible block animates 830→517→312→…→0 in ~200ms). The sticky bar's compact mode deliberately animates layout properties; it was measured as a one-shot smooth transition and is not in these plans.
- The user explicitly allows a good existing icon set; plan 008 keeps the current Feather/Lucide-style icons and normalizes their caps/joins/sizes instead of redrawing them.

## Running the plans

Each plan contains exact paths, code excerpts and verification commands. The relevant guards are `npm run check:types`, `npm run lint`, and the `tools/dev/test-*.mjs` cases named in each plan. The UI suite can be filtered:

```bash
node tools/dev/run-ui-tests.mjs card-motion r3 r10 i18n
```

For motion changes, also do the manual feel-check in the plan (DevTools Animations at 10%, `prefers-reduced-motion` emulation, and a real 25-second observation of the overview for the poll-replay plan).
