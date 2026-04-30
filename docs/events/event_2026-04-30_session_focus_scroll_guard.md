# Event: Session focus / scroll guard

## 需求

使用者回報 webapp 對話流中，除了自動追底模式外，瀏覽歷史時經常被搶走 focus / viewport 位置。

## 範圍

IN:

- 調查並修復 session conversation 中非預期的 focus / scroll 搶位。
- 優先保護 `free-reading` 狀態下的閱讀位置。

OUT:

- 不改 backend session/event contract。
- 不重啟 daemon / gateway。

## 任務清單

- 1.1 Add a free-reading-aware guard to session hash initial bottom scroll.
- 1.2 Prevent page-level printable-key autofocus from stealing focus while browsing history.
- 1.3 Add targeted tests for free-reading hash/autofocus behavior where feasible.
- 1.4 Run focused frontend tests / type checks for touched modules.
- 1.5 Exclude tool call wrappers from browser scroll anchoring.
- 1.6 Disable session scroll-snap while runloop/toolcall updates are active.
- 1.7 Stop reactive hash replay from repositioning free-reading viewports.
- 1.8 Remove session proximity scroll-snap entirely after short-toolcall reproduction.
- 1.9 Treat user scroll events as free-reading during active tool updates instead of correcting back to bottom.
- 1.10 Exclude outer message turn wrappers from browser scroll anchoring.
- 1.11 Route all root scroll events through auto-scroll state handling while keeping scrollSpy gesture-gated.
- 1.12 Prevent toolcall working-start from forcing bottom when already away from bottom.
- 1.13 Make explicit pause remember reading intent even before overflow grows.
- 2.1 Update event log with checkpoints and validation.
- 2.2 Check architecture sync and document no-change or update as needed.

## Debug Checkpoints

### Baseline

- Symptom: browsing session history can be pulled back to composer focus or bottom/message position.
- Evidence read:
  - `packages/app/src/pages/session.tsx` page-level keyboard autofocus and scroll wiring.
  - `packages/app/src/pages/session/use-session-hash-scroll.ts` hash/initial scroll behavior.
  - `packages/app/src/pages/session/message-timeline.tsx` lazy history sentinel.
  - `packages/app/src/components/prompt-input.tsx` composer-local focus paths.

### Instrumentation Plan

- Use existing `opencode:scroll-debug` logs if manual browser validation is needed.
- Code-level checkpoints: userScrolled/free-reading guard, hash scroll entrypoints, page-level keydown autofocus.

### Execution

- Added optional `userScrolled?: () => boolean` input to `useSessionHashScroll`.
- No-hash automatic `scrollToBottom()` now returns early while the caller is in free-reading mode.
- Initial session-ready handling preserves explicit hash navigation, but skips implicit bottom scroll when free-reading.
- Session page passes `autoScroll.userScrolled` into the hash-scroll hook.
- Page-level printable-key autofocus now returns early while `autoScroll.userScrolled()` is true.
- Added hook tests for no-hash free-reading preservation and explicit hash navigation while free-reading.
- Added `overflow-anchor: none` to the base `tool-part-wrapper` so non-sticky tool bubbles cannot become root scroll-anchor candidates.
- Added `data-session-busy` to the session scroller and disabled `scroll-snap-type: y proximity` while the runloop/session is busy.
- Added a free-reading guard before non-initial reactive `applyHash("auto")`, so stale `#message-...` anchors are not replayed on every message/toolcall update.
- Removed session-scroller proximity snap entirely after reproduction showed short toolcall gaps could still snap nearby active turns.
- Removed `createAutoScroll.handleScroll()`'s active-streaming correction path that treated user scroll events away from bottom as anchor restoration and forced `scrollTop` back to bottom.
- Added `overflow-anchor: none` to the outer `[data-message-id]` turn wrapper, because the visible user message text (`已重啟`) indicated the browser could still select the whole turn wrapper as the fixed scroll anchor even though inner user/tool nodes were excluded.
- Routed every root scroller `scroll` event through `autoScroll.handleScroll()` so any actual away-from-bottom scroll can enter `free-reading`; `scrollSpy` remains gesture-gated to avoid non-interactive active-message churn.
- Added a `working-start-away-from-bottom` guard in `createAutoScroll`: when a new toolcall starts while the root scroller is already away from bottom, switch to `free-reading` instead of calling `scrollToBottom(true)`.
- Changed `pause()` to force `free-reading` via `stop(true)`, so explicit upward scroll / user reading intent is remembered even when content is still near-bottom or has not yet grown enough to create overflow.
- After user reported no behavioral change, traced the remaining owner to the programmatic-scroll marker used by resize-follow. Wheel/touch reading intent now clears the pending auto marker before calling `stop()`, so the next root `scroll` event cannot be swallowed as a recent automatic scroll.
- After the post-restart test still showed no behavioral change, removed the broad active invariant: session page no longer passes `working: () => true` into `createAutoScroll`; it passes the real `sessionBusy` signal. Root-level wheel/touch handlers now treat any valid vertical gesture as reading intent, not only upward deltas.
- User pointed out the tool-card-specific default display behavior. Re-read `message-part.tsx`, `basic-tool.tsx`, `collapsible.tsx`, and related CSS; tool cards differ in `defaultOpen`/`forceOpen` and resulting height changes, but they all feed the same content resize observer. Added a resize-follow guard that switches to `free-reading` when a resize arrives while the viewport is already away from bottom.
- User observed the viewport now anchors upward at the previous toolcall batch start and that any toolcall update is the trigger. Found `SessionTurn` has its own nested `[data-slot="session-turn-content"]` `overflow-y: auto` container; disabled browser scroll anchoring there too. Also tightened resize-follow to only follow when physically at bottom (`distance <= 1`) and removed the post-resize snap-back path.
- Checked MDN `overflow-anchor`: scroll anchoring is browser-default behavior, not React/Solid behavior; `overflow-anchor: none` opts elements out and MDN's prevention example uses `* { overflow-anchor: none; }`. Updated the session-scoped rule to `.session-scroller, .session-scroller * { overflow-anchor: none; }` so every tool card / message descendant is excluded as an anchor candidate.
- User screenshot showed the latest message/composer boundary was being held at the bottom. Found `SessionTurn` globally uses `height: 100%`; in the session timeline that makes every turn a viewport-height block, so the last user message naturally occupies the composer edge. Added a session-timeline-only class that overrides the turn and content wrappers to content height.
- User clarified the apparent click/selection jump also happens without a running loop and looks like the viewport moves upward by the height of the prompt card. Reframed the boundary: the session scroller's visual bottom is the prompt dock top edge, not the browser viewport bottom. Added `scroll-padding-bottom` on `.session-scroller` using `--prompt-height` so native selection/focus/scrollIntoView-style scroll operations account for the overlay.
- User reported that follow-bottom mode still jitters down by about one line on each toolcall-card update before restoring. The likely boundary is resize-follow applying `scrollTop += delta` after the browser has already partially/clamped the bottom position. Changed resize-follow to set the exact current bottom (`scrollHeight - clientHeight`) instead of adding the delta, avoiding overshoot and next-frame clamp-back.
- User clarified toolcall card height is effectively constant, so follow-bottom math should not be difficult or heuristic. Consolidated all auto-scroll bottom writers (`markAuto`, rAF follow loop, smooth scroll, immediate scroll, resize-follow) onto a single `bottomScrollTop(el)` formula instead of mixing `scrollHeight`, clamped browser behavior, and delta math.
- User refined the jitter symptom: at the instant a toolcall completes, a bottom status/output line appears to disappear, the page scrolls down briefly, then returns. Added a dedicated bottom anchor sentinel at the end of the session timeline and re-enabled browser scroll anchoring only for that sentinel while in follow-bottom mode. Free-reading still disables the sentinel anchor.
- User confirmed the remaining one-line jitter matches the `正在考慮下一步` / status row disappearing and reappearing around toolcall boundaries. Changed `SessionTurn` so the status row remains mounted for the duration of `working()` and uses `visibility: hidden` when inactive, preserving its vertical slot without exposing stale status text.
- Regression after commit `b0f06265c`: user reported the follow-bottom button could no longer lock follow-bottom. Re-read `create-auto-scroll.tsx` and found explicit `resume()` only changed the mode, while the newer away-from-bottom guards (`resize-away-from-bottom`, `resize-remaining-away-from-bottom`, `working-start-away-from-bottom`) could immediately flip the state back to `free-reading`. Added an explicit follow latch set by `resume()` and cleared only by real user scroll/interaction, so explicit follow-bottom can override those stale-mode guards while user intent still exits follow mode.

### Root Cause

- The session page had two non-explicit reposition paths that were not gated by free-reading state:
  1. `useSessionHashScroll` treated no-hash initial/session updates as permission to scroll to bottom.
  2. Page-level printable-key handling focused the prompt whenever the active element was not protected/input-like.
- During history browsing, these paths could run independently of the user's explicit resume-bottom intent, making the viewport or focus feel stolen.
- Explicit message hash navigation remains intentional and continues to pause auto-scroll and navigate to the target.
- Follow-up evidence: the stronger symptom during long autonomous runs was not viewport push from height reflow, but repeated anchoring to the runloop turn start.
- That path matched CSS scroll snap: `.session-scroller[data-user-scrolling]` enabled `scroll-snap-type: y proximity`, while each `[data-message-id]` had `scroll-snap-align: start`. Continuous toolcall updates during `sessionBusy()` could therefore let the browser repeatedly snap the free-reading viewport back to the active turn/runloop start.
- The snap behavior is now retained only for non-busy reading; busy runloop/toolcall updates do not enable proximity snap.
- User clarified the pullback happens regardless of distance, which rules out proximity snap as the primary cause.
- Primary follow-up root cause: stale URL hash replay. `useSessionHashScroll` kept re-running `applyHash("auto")` after initial load whenever reactive inputs changed and `working()` was false. During long toolcall/runloop sequences, any stale `#message-...` for the runloop start could therefore force `scrollToMessage()` from any distance.
- Explicit deep links remain supported on initial load and via real `hashchange`; only implicit reactive hash replay is blocked while `userScrolled()` is true.
- Final reproduction evidence: when the active user message text (for example `已重啟`) remained in the viewport, every short independent toolcall update pulled back toward that active turn.
- Final root cause: `MessageTimeline` only calls `autoScroll.handleScroll()` while `hasScrollGesture()` is true, so this entrypoint is user-gesture scoped. However `createAutoScroll.handleScroll()` had an active-streaming branch that interpreted any away-from-bottom scroll as iOS/browser anchor restoration and synchronously corrected back to bottom. This prevented shallow-but-intentional user scrolls near the active turn from entering `free-reading`, so subsequent tool updates kept following/correcting the viewport.
- The correction branch was removed; explicit follow-bottom still uses resize delta / resume-bottom behavior, while user scroll gestures away from bottom now reach the normal `stop()` path and enter `free-reading`.
- Additional root cause refinement: the observed fixed point was the user-message text itself, not the bottom. This implies browser scroll anchoring could still target the outer `#message-*` / `[data-message-id]` wrapper. Inner elements already had `overflow-anchor: none`, but the wrapper did not; excluding the wrapper removes that remaining candidate.
- Additional root cause refinement: the previous `MessageTimeline` gate called `autoScroll.handleScroll()` only while `hasScrollGesture()` was true. Some real scroll paths can update the root scroller without staying inside that short gesture window, leaving auto-scroll mode as `follow-bottom`; subsequent toolcall resize then continued to preserve the visible active-turn area. Handling every root scroll closes that gap while keeping `scrollSpy` gated.
- Final follow-up symptom: after anchor locking stopped, new toolcall trigger still forced follow-bottom. Cause: `createAutoScroll`'s `working-start` branch unconditionally called `scrollToBottom(true)` whenever mode had not yet flipped to `free-reading`. The new guard checks physical distance from bottom first, making away-from-bottom position authoritative even if mode is stale.
- Last-mile root cause: the physical-distance guard still misses cases where the user has already expressed reading intent while the timeline is near-bottom / not yet overflowed. Previously `pause()` called `stop()` and `stop()` returned early when `canScroll()` was false, discarding the intent. Forced pause now records `free-reading` regardless of current overflow.
- Post-retry evidence: the issue remained unchanged after forced pause, so prior fixes were insufficient. Re-read `createAutoScroll` end-to-end and found the remaining race: `createResizeObserver` marks resize-follow scrolls as programmatic for 250ms, while the page keeps `createAutoScroll({ working: () => true })` active. A user wheel/touch during that window can be followed by a root scroll event that `handleScroll()` classifies as `isAuto()`, preventing `free-reading` from latching. Clearing the pending auto marker at explicit wheel/touch intent makes user intent authoritative over resize-follow bookkeeping.
- Post-restart failure of the auto-marker fix showed the broader invariant was still wrong: `working: () => true` made resize-follow eligible all the time, so every render/content resize had auto-scroll authority even outside real session activity. Also, both the UI handler and native auto-scroll listener only treated one scroll direction as explicit reading intent. The new boundary is: auto-scroll follow work is active only while `sessionBusy()` is true, and any root vertical wheel/touch gesture is sufficient to latch reading mode unless a nested scrollable actually consumes it.
- Tool-card refinement: bash/read/glob/grep/edit/task cards do have different default display behavior, but the shared failure mode is `createResizeObserver` in `createAutoScroll`: when a tool card insertion/expansion changes content height and mode has not yet latched as `free-reading`, the resize handler applied `scrollTop += delta` and could snap to bottom. The new invariant is that resize-follow is allowed only when the pre-resize viewport is still within the follow threshold; if it is already away from bottom, resize becomes evidence of reading mode and is blocked.
- Anchor-lock refinement: root `.session-scroller` already had `overflow-anchor: none`, but `SessionTurn` contains an inner scroll container (`[data-slot="session-turn-content"] { overflow-y: auto }`) that could still participate in browser anchor selection. That explains the "must pick some anchor" behavior at a previous toolcall batch boundary. The nested container now also opts out. JS resize-follow also no longer performs a snap-back if the remaining distance is large after a tool update; it switches to `free-reading` instead.
- Standards check: MDN describes scroll anchoring as default browser behavior that adjusts scroll position to minimize content shifts; `overflow-anchor` applies to all elements, is not inherited, and `none` prevents an element from being a potential anchor. Therefore excluding only a few wrappers is insufficient for a reactive tool timeline; the session scroller now excludes its entire subtree.
- Layout root cause: `SessionTurn`'s default `height: 100%` is valid for share/detail surfaces, but in the continuous session timeline it turns each message turn into a full viewport-height row. This explains why the user's latest sentence looked locked to the bottom above the composer even after anchor candidates were excluded. The session timeline now opts into `.session-timeline-turn`, which uses `height: auto` and non-scrollable content height.
- Visual-bottom root cause: native browser scroll operations triggered by clicking/selecting streaming text can use the physical scrollport bottom, while the prompt dock is an absolute overlay at the bottom of the session panel. Without scroll padding, the browser can consider a line visible even when it is hidden under the prompt dock, causing the viewport to settle several lines too high/low relative to the user's visual bottom. The scroller now declares a bottom scroll padding equal to the measured prompt height plus the existing breathing room.
- Follow-bottom jitter root cause refinement: tool card updates change `scrollHeight` while the viewport is already at bottom. A delta-add strategy (`scrollTop += delta`) can overshoot when the browser has already adjusted/clamped the scroll position for the new layout, producing a one-line downward twitch followed by clamp-back. Resize-follow now writes the exact max scrollTop for the current layout.
- Follow-bottom invariant: every JS follow-bottom path must write the same exact bottom coordinate, `max(0, scrollHeight - clientHeight)`. Do not rely on browser clamping from `scrollTop = scrollHeight`, and do not add resize deltas when the desired target is a stable bottom coordinate.
- Completion jitter root cause refinement: when a running status row / transient line disappears on tool completion, JS can only correct after layout has already produced a visible frame. The bottom sentinel makes the browser's own layout-time scroll anchoring preserve the bottom edge before JS follow-bottom code runs, while the rest of the reactive message subtree remains excluded from anchoring.
- Final status-row root cause refinement: `SessionTurn` previously mounted the inline status row only when `retry()` or `(working() && active())` was true. At toolcall handoff/completion boundaries, `working()` can remain true while `active()` briefly drops false, removing the row and collapsing one line of height. Keeping the row mounted while `working()` is true makes the layout height stable across that boundary.
- Follow-bottom regression root cause: the anti-steal guards treated every away-from-bottom measurement as reading intent, but after an explicit resume the away-from-bottom distance can be transient/stale while the browser, ResizeObserver, or working-start transition is still settling. Without a separate explicit-follow latch, the same guards that protected free-reading also defeated the user's explicit request to lock onto bottom.

### Validation

- `bun test --preload ./happydom.ts ./src/pages/session/__tests__/use-session-hash-scroll.test.ts` from `packages/app`: 0 pass / 5 skip / 0 fail. Existing test file is guarded by Solid `isServer`, so the new cases are present but skipped in this runtime.
- `bun run typecheck` from `packages/app`: failed on pre-existing unrelated `packages/ui/src/components/session-review.tsx` `FileDiff.before/after` type errors; no errors reported in touched session files before that blocker.
- `bun run eslint packages/app/src/pages/session.tsx packages/app/src/pages/session/use-session-hash-scroll.ts packages/app/src/pages/session/__tests__/use-session-hash-scroll.test.ts`: passed with no errors/warnings after removing one stale eslint-disable in the touched file.
- `git diff --check -- packages/app/src/pages/session.tsx packages/app/src/pages/session/use-session-hash-scroll.ts packages/app/src/pages/session/__tests__/use-session-hash-scroll.test.ts`: passed.
- Follow-up focused eslint: `bun run eslint packages/app/src/pages/session.tsx packages/app/src/pages/session/message-timeline.tsx`: passed.
- Follow-up whitespace check: `git diff --check -- packages/app/src/pages/session.tsx packages/app/src/pages/session/message-timeline.tsx packages/ui/src/styles/tailwind/utilities.css packages/ui/src/components/message-part.css`: passed.
- Latest focused eslint: `bun run eslint packages/app/src/pages/session.tsx packages/app/src/pages/session/message-timeline.tsx packages/app/src/pages/session/use-session-hash-scroll.ts`: passed.
- Latest whitespace check: `git diff --check -- packages/app/src/pages/session.tsx packages/app/src/pages/session/message-timeline.tsx packages/app/src/pages/session/use-session-hash-scroll.ts packages/ui/src/styles/tailwind/utilities.css packages/ui/src/components/message-part.css plans/20260430_session_focus_scroll_guard/tasks.md docs/events/event_2026-04-30_session_focus_scroll_guard.md`: passed.
- Final focused eslint: `bun run eslint packages/ui/src/hooks/create-auto-scroll.tsx packages/app/src/pages/session/message-timeline.tsx`: passed.
- Final whitespace check: `git diff --check -- packages/ui/src/hooks/create-auto-scroll.tsx packages/ui/src/styles/tailwind/utilities.css packages/app/src/pages/session/message-timeline.tsx`: passed.
- Turn-wrapper whitespace check: `git diff --check -- packages/ui/src/components/session-turn.css packages/ui/src/hooks/create-auto-scroll.tsx packages/ui/src/styles/tailwind/utilities.css`: passed.
- Scroll-event gate focused eslint: `bun run eslint packages/app/src/pages/session/message-timeline.tsx packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Scroll-event gate whitespace check: `git diff --check -- packages/app/src/pages/session/message-timeline.tsx packages/ui/src/hooks/create-auto-scroll.tsx packages/ui/src/components/session-turn.css`: passed.
- Working-start guard focused eslint: `bun run eslint packages/ui/src/hooks/create-auto-scroll.tsx packages/app/src/pages/session/message-timeline.tsx`: passed.
- Working-start guard whitespace check: `git diff --check -- packages/ui/src/hooks/create-auto-scroll.tsx packages/app/src/pages/session/message-timeline.tsx`: passed.
- Forced-pause focused eslint: `bun run eslint packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Forced-pause whitespace check: `git diff --check -- packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Auto-marker-clear focused eslint: `bun run eslint packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Auto-marker-clear whitespace check: `git diff --check -- packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Active-scope focused eslint: `bun run eslint packages/app/src/pages/session.tsx packages/app/src/pages/session/message-timeline.tsx packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Active-scope whitespace check: `git diff --check -- packages/app/src/pages/session.tsx packages/app/src/pages/session/message-timeline.tsx packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Resize-away focused eslint: `bun run eslint packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Resize-away whitespace check: `git diff --check -- packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Nested-anchor/strict-resize focused eslint: `bun run eslint packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Nested-anchor/strict-resize whitespace check: `git diff --check -- packages/ui/src/components/session-turn.css packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Scoped-anchor focused eslint: `bun run eslint packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Scoped-anchor whitespace check: `git diff --check -- packages/ui/src/styles/tailwind/utilities.css packages/ui/src/components/session-turn.css packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Timeline-turn focused eslint: `bun run eslint packages/app/src/pages/session/message-timeline.tsx packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Timeline-turn whitespace check: `git diff --check -- packages/app/src/pages/session/message-timeline.tsx packages/ui/src/components/session-turn.css plans/20260430_session_focus_scroll_guard/tasks.md docs/events/event_2026-04-30_session_focus_scroll_guard.md`: passed.
- Visual-bottom manual validation after frontend restart: user confirmed the click/selection reverse-scroll behavior disappeared. This validates the prompt-overlay bottom-boundary fix (`scroll-padding-bottom` on `.session-scroller`) as the first observed effective correction for the reported click-triggered jump.
- Status-row jitter manual validation after frontend restart: user confirmed the follow-bottom toolcall completion jitter is fixed. This validates keeping `session-turn-status-inline` mounted during `working()` and hiding it with `visibility: hidden` when inactive, so the transient "considering next steps" row no longer collapses layout between tool calls.
- Status-row focused eslint: `bun run eslint packages/ui/src/components/session-turn.tsx`: passed.
- Status-row whitespace check: `git diff --check -- packages/ui/src/components/session-turn.tsx packages/ui/src/components/session-turn.css docs/events/event_2026-04-30_session_focus_scroll_guard.md`: passed.
- Explicit-follow focused eslint: `bun run eslint packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Explicit-follow whitespace check: `git diff --check -- packages/ui/src/hooks/create-auto-scroll.tsx`: passed.
- Architecture Sync: Verified (No doc changes). Basis: changes stay within existing `packages/app/src/pages/session/` focus/scroll coordination and do not introduce new module boundaries, backend contracts, state authorities, or runtime flows.

## XDG Backup

- Pre-implementation whitelist snapshot: `/home/pkcs12/.config/opencode.bak-20260430-1947-session_focus_scroll_guard`.
- This is a plan-start snapshot only; do not restore unless explicitly requested by the user.
