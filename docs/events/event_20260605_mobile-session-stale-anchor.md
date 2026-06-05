# Mobile Session Stale Anchor Regression (2026-06-05)

## 需求

- 修正 mobile app session 畫面在 reconnect / 畫面更新後自動 fold 變黑的 regression。
- 使用者症狀：像是保留了指向未載入訊息的錨點，畫面更新後反覆跳回不可見位置，導致 session 畫面全黑。

## 範圍

- IN: `packages/app/src/pages/session/use-session-hash-scroll.ts` 的 hash/message anchor 邏輯。
- IN: `packages/app/src/pages/session.tsx` 新 user input 出現後清理舊 hash 的 session wiring。
- IN: `packages/app/src/pages/session/__tests__/use-session-hash-scroll.test.ts` regression test。
- OUT: 不重寫 session virtualization / lazy-load 架構，不新增 fallback mechanism。

## 任務清單

- [x] 追溯昨日 mobile fold / reset 相關 issue 與 archived specs。
- [x] 定位 reconnect 後 stale `#message-*` hash 重放路徑。
- [x] 修正 stale message hash：不 pause auto-scroll、清掉 hash、回到底部並同步 scroll state。
- [x] 修正 valid-but-stale last-input hash：沒有 pending explicit navigation 時，初始載入不再重播 URL message hash。
- [x] 補 regression test：即使 `userScrolled=true`，stale message hash 也會回 tail。
- [x] 補 regression test：有效 message hash 若不是 pending navigation，不會 pause / 跳到該 input。
- [x] 收尾驗證與 architecture sync。

## Debug Checkpoints

- Checkpoint 1 — Evidence: `issues/issue_20260605_mobile-reset-to-first-turn-regression.md` 與 archived mobile/session specs 顯示這是 large-session/mobile reconnect 類 regression，不能只修單一 render window。
- Checkpoint 2 — Boundary: `use-session-hash-scroll.ts` 初始 hash apply 在 `messagesReady` 後重放 `window.location.hash`；若 hash 是 `message-*` 但該 message 不在 `visibleUserMessages()`，舊邏輯已先 `autoScroll.pause(true)` 並直接 return。
- Checkpoint 3 — Root cause: stale message hash 目標不存在時，auto-scroll 被強制暫停，hash 仍留在 URL；reconnect / hydration 重新觸發 effect 後會反覆嘗試同一不可見 anchor，而不是回到 tail。
- Checkpoint 4 — Correction: 使用者指出 dialog stream 跳回 last-input anchor 的本能仍可能存在；重新追查後確認第一版只修 missing target，不足以涵蓋「hash 指向仍可見但已過時的上一個 input」路徑。
- Checkpoint 5 — Root cause extension: `use-session-hash-scroll.ts` 初始載入只要看到有效 `#message-*` 就視為 explicit navigation；mobile reconnect / `forceReload` 後，URL 殘留的 last input hash 會被當成導航錨點重播，與 follow-bottom 競爭。

## Key Decisions

- 對 stale `#message-*` 採 fail-fast 清理：清除 hash、回到底部、更新 scroll state。
- 只有找到有效 message hash / DOM target 時才 `pause(true)`；stale anchor 不得進入 free-reading/pause 狀態。
- stale message hash 不尊重 `userScrolled=true`，因為這是失效 URL anchor，不是使用者主動停在歷史位置。
- URL message hash 只在 `pendingMessage` 明確存在時才作為 initial navigation；一般 reconnect/hydration 不再把殘留 hash 當導航意圖。
- 當最新 visible user message 改變，`session.tsx` 立即清 `store.messageId` 與 URL hash，讓新 input / stream 以 tail 為權威。

## Verification

- Passed: `bun test --preload ./happydom.ts ./src/pages/session/__tests__/use-session-hash-scroll.test.ts --test-name-pattern 'pending navigation|free reading'` from `packages/app` (`2 pass`, 7 expects)。
- Note: direct `applyHash` effect-style tests remain client-gated under the Solid server test bundle; the free-read/pending-navigation boundary is covered by `shouldReplayInitialHash` and the free-read direct branch test.
- Passed: `bun node_modules/typescript/bin/tsc -p packages/app/tsconfig.json --noEmit`。
- Passed: `git diff --check`。
- Note: full hash-scroll test file currently reports existing Solid SSR client-gated tests as skipped; the new stale regression is non-skipped when run by name.
- Architecture Sync: Updated `specs/architecture.md` I-4 mobile collapse entry with stale/valid-but-stale anchor boundary.

## Remaining

- 若實機 mobile 仍黑屏，下一步應檢查 dialog stream message ordering / virtualization render window 是否把 current assistant output 插回 older parent。
