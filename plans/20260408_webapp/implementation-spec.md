# Implementation Spec

## Goal

- 為 webapp session prompt input 規劃一個 capability-based 語音輸入方案：桌面與 iPhone / Android 等可支援瀏覽器共用 browser-only 即時語音辨識，僅在能力不足時才切到明確的不可用處理，以最小可落地改動提供可驗證的語音輸入體驗。

## Scope

### IN

- 在 `packages/app/src/components/prompt-input.tsx` 加入 mic button、路徑狀態與基本互動保護。
- 桌面與 iPhone / Android 等支援瀏覽器共用 `packages/app/src/utils/speech.ts` 作為唯一 speech recognition state surface。
- 將 transcript 整合到 `contenteditable` editor 與 `usePrompt()` 狀態。
- 新增 i18n 文案、unsupported/error 提示、iPhone / Android capability gate 與最小測試/手動驗證。

### OUT

- TUI / desktop parity。
- 進階語音體驗（自訂語言、降噪、標點後處理、長時段錄音策略）。
- 若某些 mobile browsers 完全不支援 Web Speech API，後續才另行評估替代路徑，不在本次先凍結。

## Assumptions

- `packages/app/src/utils/speech.ts` 已足夠支援即時辨識所需的 start/stop/interim/final 狀態，不需要新增第二套 speech abstraction。
- iPhone / Android 若實際暴露 `SpeechRecognition` 或 `webkitSpeechRecognition`，就應直接啟動同一套 speech 路徑。
- Prompt editor 允許透過既有 `addPart(...)` / `prompt.set(...)` 流程安全插入由語音辨識產生的純文字。
- 桌面與 iPhone / Android 共用同一個 prompt 回填 contract。
- 現階段不需要全量 server-side observability，但 unsupported 狀態至少要能驗證成功與失敗狀態。

## Stop Gates

- 若 `contenteditable` editor 與 speech transcript 整合導致 cursor/history/IME 顯著不穩，必須停止並回到 planning，重新評估插入策略。
- 若現有 `speech.ts` 無法提供穩定的 final/interim 邊界而需要重寫核心 speech state，必須停下確認是否擴大範圍。
- 若 iPhone / Android capability gate 無法可靠判定是否可用，必須明確標示 unsupported，而不是猜測或默認降級。
- 若需要新增 fallback mechanism 掩蓋 unsupported/error path，必須停止；本案維持 fail-fast。

## Critical Files

- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/utils/speech.ts`
- `packages/app/src/utils/runtime-adapters.ts`
- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zht.ts`
- `packages/app/src/components/prompt-input/submit.test.ts`
- `docs/events/event_20260408_webapp_voice_input_mvp.md`

## Structured Execution Phases

- Phase 1: Confirm prompt editor integration strategy and define dual-path mic control UX/state model.
- Phase 2: Integrate desktop browser speech recognition into `prompt-input` with unsupported/error/recording states.
- Phase 3: Add iPhone / Android capability detection and verify the shared prompt state contract.
- Phase 4: Add validation coverage, update event documentation, and verify architecture sync status.

## Validation

- Run targeted app lint/typecheck for touched files.
- Run focused unit tests for prompt-input related behavior; add/adjust tests where speech-driven state changes affect prompt semantics.
- Manually verify desktop supported path: start recording, observe interim text, stop recording, final text remains editable, prompt can still submit normally.
- Manually verify mobile path: iPhone / Android browsers can use voice input end-to-end when capability is detected.
- Manually verify unsupported path: no silent failure; UI clearly indicates voice input is unavailable or uses the correct alternate path.
- Manually verify no regression for attachment button, send/stop button, shell mode, and existing prompt typing behavior.

## Handoff

- Build agent must read this spec first.
- Build agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Build agent must materialize runtime todo from `plans/20260408_webapp/tasks.md` before coding.
- Build agent must keep `plans/20260408_webapp/tasks.md` as the canonical execution checklist.
- Conversation memory is supporting context only, not the execution source of truth.
- If scope changes or a new slice appears, update the same plan root unless a new plan is explicitly user-approved.
- At completion time, review implementation against the proposal's effective requirement description.
