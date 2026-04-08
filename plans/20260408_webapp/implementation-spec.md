# Implementation Spec

## Goal

- 為 webapp session prompt input 規劃一個 browser-only 語音轉文字 MVP，重用既有 `SpeechRecognition` 封裝，以最小改動提供可驗證的語音輸入體驗。

## Scope

### IN

- 在 `packages/app/src/components/prompt-input.tsx` 加入 mic button、錄音狀態與基本互動保護。
- 使用 `packages/app/src/utils/speech.ts` 作為唯一 speech recognition state surface。
- 將 interim / final transcript 整合到 `contenteditable` editor 與 `usePrompt()` 狀態。
- 新增 i18n 文案、unsupported/error 提示與最小測試/手動驗證。

### OUT

- 後端 STT / Whisper / provider audio transcription API。
- 音訊檔案錄製、上傳、附件、持久化或回放。
- TUI / desktop parity。
- 進階語音體驗（自訂語言、降噪、標點後處理、長時段錄音策略）。

## Assumptions

- `packages/app/src/utils/speech.ts` 已足夠支援 MVP 所需的 start/stop/interim/final 狀態，不需要新增第二套 speech abstraction。
- Prompt editor 允許透過既有 `addPart(...)` / `prompt.set(...)` 流程安全插入由語音辨識產生的純文字。
- 使用者接受 MVP 僅在支援 Web Speech API 的瀏覽器中提供功能。
- 現階段不需要 server-side observability 或後端語音權限管理。

## Stop Gates

- 若 `contenteditable` editor 與 speech transcript 整合導致 cursor/history/IME 顯著不穩，必須停止並回到 planning，重新評估插入策略。
- 若現有 `speech.ts` 無法提供穩定的 final/interim 邊界而需要重寫核心 speech state，必須停下確認是否擴大範圍。
- 若使用者改為要求跨瀏覽器穩定性或後端 STT，必須回到 planning 擴大方案。
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

- Phase 1: Confirm prompt editor integration strategy and define mic control UX/state model.
- Phase 2: Integrate browser speech recognition into `prompt-input` with unsupported/error/recording states.
- Phase 3: Add validation coverage, update event documentation, and verify architecture sync status.

## Validation

- Run targeted app lint/typecheck for touched files.
- Run focused unit tests for prompt-input related behavior; add/adjust tests where speech-driven state changes affect prompt semantics.
- Manually verify in a supported Chromium browser: start recording, observe interim text, stop recording, final text remains editable, prompt can still submit normally.
- Manually verify unsupported path: no silent failure; UI clearly indicates voice input is unavailable.
- Manually verify no regression for attachment button, send/stop button, shell mode, and existing prompt typing behavior.

## Handoff

- Build agent must read this spec first.
- Build agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Build agent must materialize runtime todo from `tasks.md` before coding.
- Conversation memory is supporting context only, not the execution source of truth.
- If scope changes or a new slice appears, update the same plan root unless a new plan is explicitly user-approved.
- At completion time, review implementation against the proposal's effective requirement description.