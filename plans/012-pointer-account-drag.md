# 012 — Pointer Events account drag (replace native HTML5 DnD)

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7 (base; applied after 011)
- **Severity**: MEDIUM (interaction rewrite)
- **Category**: Direct manipulation / Physics / Accessibility
- **Estimated scope**: `dashboard/public/index.html`, `dashboard/public/style.css`, `tools/dev/test-account-order.mjs`

## Why this pass

The account reorder used native HTML5 DnD. The browser owns the drag image and drop feedback, so the row could not track the pointer 1:1, carry velocity into a settle, project momentum, or resist at the list boundaries. The user explicitly asked to rewrite it after finding the drag unsatisfying.

Skill mapping: Apple *Designing Fluid Interfaces* §1 response / §2 direct manipulation / §3 interruptibility / §4 springs / §5 velocity handoff / §6 momentum projection / §9 rubber-banding; Emil §3 physicality and §4 interruptibility. The Up/Down buttons remain the keyboard/assistive path.

## Implementation

All in `wireAccountPointerDrag()` in `dashboard/public/index.html`, plus the grip/placeholder CSS.

### Direct manipulation

- `pointerdown` on the grip (18px min hit area, `touch-action: none`) with a **4px movement threshold**; `setPointerCapture` is attempted but wrapped in try/catch and the listeners are attached to `window`, because synthetic/restricted environments can reject capture. The window listeners also keep tracking when the pointer leaves the grip.
- The row becomes `position: fixed` at its original rect and follows the pointer with the **grab offset** (`pointerY − grabOffset − originalTop`), so the drag starts exactly where the user grabbed it.
- The original slot is held by `.acct-placeholder` (height + margin measured from the row); the other account/plugin rows get a **WAAPI FLIP** (220ms, repo `--ease`) whenever the placeholder moves.
- The hover transition is disabled on the dragged row (`transition: none`) so the transform stays 1:1 instead of being tweened by `--transition-fast`.

### Live target + velocity + momentum

- Live insertion uses the next/previous account row's midpoint with an **8px hysteresis** to avoid boundary flicker; plugin-only rows are skipped as targets but still FLIP.
- Pointer samples are kept for the last **120ms**; release velocity is `px/s`.
- On release the target is chosen from the **projected endpoint** using Apple's exponential projection:

```js
const projection = (v, d = 0.998) => (v / 1000) * d / (1 - d);
const projectedY = clamp(lastY + projection(velocity), listTop, listBottom);
```

- The row then settles to the placeholder with a lightweight spring (`k = 320`, `c = 36`, response ≈ 0.35s), seeded with the release velocity (clamped ±2000px/s), with an 800ms fallback if rAF is suspended.
- Outside the list's top/bottom, the row's Y is damped with the Apple rubber-band formula (`constant 0.55`) instead of hard-stopping.

### Interruptibility, safety and fallbacks

- `Escape` or `pointercancel` reverts the placeholder to the original index and settles the row back; no order request is sent (forgiving cancel).
- An `isConnected` guard cancels the drag if the account list is re-rendered mid-drag (e.g., the 60s poll). Without it, a stale row could be inserted into the new list and duplicate an account; the earlier probe reproduced this.
- `prefers-reduced-motion` skips the FLIP/spring and snaps to the slot; the user-driven 1:1 drag still works.
- The old native `dragstart`/`dragover`/`drop` handlers are kept **only** as a synthetic-event fallback for `test-account-order`; the grip has `draggable="false"` so real browsers never start a native drag. The Up/Down buttons remain the keyboard path.
- Commit uses the existing `reorderAccount(file, target, before)`; the POST body contains the full order and is verified by the test.

## Verification

- `npm run check:types`, `npm run lint`: pass.
- `node tools/dev/run-ui-tests.mjs`: **38 / 38** pass after the rewrite, including the updated `test-account-order` (native synthetic path + the new pointer path).
- Real mouse probe (CDP `Input.dispatchMouseEvent`):
  - During the drag: row has `.acct-pointer-drag`, `.acct-placeholder` exists, the transform follows the pointer (`translateY(290px)` at the target).
  - After release: the posted order is `[b.info, c.info, a.info]` for A dropped after C; no fixed row/placeholder remains.
  - The new assertion in `test-account-order` checks the fixed row + placeholder during the drag and the final POST order.
- Existing native synthetic drag tests still pass; keyboard Up/Down tests still pass.

## Deliberate scope

- No auto-scroll while dragging near the viewport edge; the account list is short. If the list grows, add edge auto-scroll around the same rAF loop.
- The spring uses a fixed critically-damped pair rather than a designer-facing response/damping API; a future pass can expose tokens if more gesture surfaces appear.
- The pointer capture try/catch + window listeners is a compatibility fallback, not a second interaction model.
- Plugin-only rows are not reorderable targets (same as before); they still participate in the FLIP so the list does not jump around them.
