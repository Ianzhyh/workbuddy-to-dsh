# 003 — Single animation path for model chips

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7
- **Severity**: MEDIUM
- **Category**: Performance / Accessibility
- **Estimated scope**: 2 files (`dashboard/public/index.html`, `dashboard/public/style.css`), ~20 lines changed/removed

## Problem

The model-picker chip has two competing transform animations and a forced-reflow loop.

### 1. Two animations on the same element

The click handler runs a WAAPI pop (`index.html:9120-9126`):

```js
b.onclick = () => {
  const nowOn = !chosen.has(m.id);
  if (nowOn) chosen.add(m.id);
  else chosen.delete(m.id);
  updateSelection();
  b.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
    { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
  );
};
```

The CSS also attaches a keyframe animation to the state classes (`style.css:3834-3852`):

```css
.modelpick-chip.on  { animation: chipPop 0.18s var(--ease); }
.modelpick-chip.off { animation: chipPopOff 0.18s var(--ease); }
@keyframes chipPop { 0% { transform: scale(1); } 45% { transform: scale(1.06); } 100% { transform: scale(1); } }
@keyframes chipPopOff { 0% { transform: scale(1); } 45% { transform: scale(0.95); } 100% { transform: scale(1); } }
```

Measured on a clicked chip: `getAnimations()` returned 6 `CSSTransition`s + `chipPopOff` + one unnamed `Animation` (the WAAPI), all running. The WAAPI wins the transform, so the CSS animation is wasted; unchecking always pops **up** (1.06), never dips (0.95).

Note: there is a **separate** `.modelpick-chip.on` state rule at `style.css:3662-3667` (color/background/border/font-weight). It must stay; only the animation rule at 3834-3852 is removed.

### 2. Forced reflow per chip

`updateSelection()` (`index.html:9074-9082`) toggles the classes and then forces a layout for **every** chip:

```js
chips.querySelectorAll('.modelpick-chip').forEach((btn) => {
  ...
  btn.classList.toggle('on', on);
  btn.classList.toggle('off', !on);
  btn.textContent = (on ? '✓ ' : '') + id;
  btn.setAttribute('aria-pressed', String(on));
  btn.title = id + (on ? '（点击移除）' : '（点击加入）');
  void btn.offsetWidth;          // <-- one forced layout per chip
});
```

With the 30-model upstream catalogue this is up to 30 synchronous layouts per click. The reflow is only there to restart the CSS keyframe; the WAAPI does not need it.

### 3. WAAPI ignores reduced motion

The global reduced-motion rule (`style.css:4078-4088`) only compresses CSS animations/transitions. The WAAPI pop runs regardless of `prefers-reduced-motion`.

## Target

Use **one** animation path: the existing WAAPI on the clicked chip, gated by the media query, with the intended on/off direction. Remove the CSS keyframes and the reflow loop.

### A. Click handler

Replace the `b.onclick` block (`index.html:9118-9129`) with:

```js
    b.onclick = () => {
      const nowOn = !chosen.has(m.id);
      if (nowOn) chosen.add(m.id);
      else chosen.delete(m.id);
      updateSelection();

      /*
       * 只保留这一条 WAAPI：CSS 的 .on/.off keyframes 已删除，避免同一元素同时跑
       * 两条 transform；也不再为每个芯片强制回流。
       * WAAPI 不受样式表 reduced-motion 兜底影响，必须自己过一遍偏好。
       * 选中向上弹 1.06，取消向下缩 0.95（对应被删掉的 chipPop / chipPopOff 语义）。
       */
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        if (b.__pop) b.__pop.cancel();
        const peak = nowOn ? 1.06 : 0.95;
        const pop = b.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(' + peak + ')' }, { transform: 'scale(1)' }],
          { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
        );
        b.__pop = pop;
        pop.finished.catch(() => {}).finally(() => { if (b.__pop === pop) b.__pop = null; });
      }
    };
```

`b.__pop` stores the last animation so rapid clicks cancel the previous pop instead of stacking transform animations.

### B. Remove the forced reflow

Delete the single line `void btn.offsetWidth;` in `updateSelection()` (`index.html:9081`). Leave the class/text/aria/title updates intact.

### C. Remove the CSS chip keyframes

Delete the block `style.css:3834-3852` (the two animation declarations and `@keyframes chipPop` / `chipPopOff`), and update the section comment at `style.css:3827-3832` to say the micro-feedback is a WAAPI pop in `clientModelPicker`.

Do **not** touch the `.modelpick-chip.on` state rule at `style.css:3662-3667` or `.modelpick-chip:active` at 3830.

## Repo conventions to follow

- The chip is a `clientEl('button', 'modelpick-chip' + (on ? ' on' : ''), ...)` (`index.html:9113`); state classes are display-only after this change.
- The existing WAAPI easing is already the repo `--ease` value (`cubic-bezier(0.16, 1, 0.3, 1)`); keep it hard-coded in the WAAPI because there is no CSS variable access in WAAPI options.
- The reduced-motion strategy is documented at `style.css:4078-4088`; JS-driven motion must check `matchMedia` separately.
- No new dependency, no new helper.

## Steps

1. In `index.html`, replace the `b.onclick` body in `clientModelPicker()` with the target code above.
2. In `index.html`, delete `void btn.offsetWidth;` in `updateSelection()`.
3. In `style.css`, delete the two animation declarations and the two `@keyframes` (3834-3852); keep the state `.on` rule at 3662.
4. In `style.css`, update the section comment to mention the WAAPI pop.
5. Check no other selector references `chipPop` / `chipPopOff` (`grep -n "chipPop" dashboard/public`), then run Verification.

## Boundaries

- Do NOT change the chip selection logic, `chosen` set, config text generation, or `clientModelIds()`.
- Do NOT remove `.modelpick-chip.on` at `style.css:3662` (colors/weight) — only the animation rule at 3834.
- Do NOT remove `.modelpick-chip:active { transform: scale(0.94); }`.
- Do NOT add a reflow workaround or a second animation.
- No new dependencies.
- If the code has drifted since d5a91c7, STOP and report.

## Verification

- **Mechanical**:
  - `npm run check:types`
  - `npm run lint`
  - `node tools/dev/test-clients-panel.mjs`
  - `node tools/dev/test-model-picker-catalog.mjs`
  - `node tools/dev/test-accent-schemes.mjs` — the selected chip's color/contrast must not change.
  - `node tools/dev/test-text-spacing.mjs` — no new clipping.
- **Feel check**:
  - Open 客户端接入 → 手动接入（复制片段） → the model picker. Click a selected chip: it should dip (0.95) and return; click an unselected chip: it should pop up (1.06) and return. No other chip should move.
  - In DevTools Console, after a click: `document.querySelector('.modelpick-chip').getAnimations()` should contain **one** animation on the clicked chip (plus its color transitions), and no unnamed WAAPI + CSS pair. Other chips should show `[]`.
  - Rapidly click the same chip 5 times: the pop must restart cleanly, not stack or freeze. The chip must return to `scale(1)`.
  - With 30 models loaded, use the Performance panel around a click: no long layout bars from `offsetWidth`; the long-task duration should be well below 50ms.
  - Toggle `prefers-reduced-motion: reduce`: clicking a chip must change its state with **no** scale animation.
- **Done when**: one animation path, no forced reflow, reduced-motion respected, all checks pass.
