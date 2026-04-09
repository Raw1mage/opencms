# Design

## Context

- webapp session 輸入面主要由 `packages/app/src/components/prompt-input.tsx` 負責；其 editor 採 `contenteditable`，並透過 `usePrompt()` 持有 canonical prompt parts/state。
- 目前 `prompt-input` 已整合附件、slash command、@mention、shell mode、history、quota footer 等多種互動，代表任何新功能都必須尊重既有 editor ownership。
- codebase 已存在 `packages/app/src/utils/speech.ts`，其封裝 browser `SpeechRecognition` / `webkitSpeechRecognition`，並提供 `isSupported`、`isRecording`、`committed`、`interim`、`start`、`stop`。
- iPhone / Android 只要實際暴露 `SpeechRecognition` / `webkitSpeechRecognition`，就應直接走與桌面相同的 speech helper 路徑；本 plan 的重點是 capability detection，而不是預設手機替代路徑。
- 目前 speech helper 尚未接入 `prompt-input` UI；因此重點是把既有 speech infra 接到可用的 route policy 上。

## Goals / Non-Goals

**Goals:**

- 以最小程式面積把 browser speech recognition 接入 webapp prompt input。
- 讓錄音狀態、unsupported path、停止行為都是顯式且 fail-fast。
- 維持 prompt state、editor rendering、送出流程的一致性。
- 為 iPhone / Android / 可支援的 mobile browser 提供可用的 voice-input path，基於 capability detection 決定是否啟用。

**Non-Goals:**

- 不一次性完成長期語音產品化（語言切換、降噪、push-to-talk advanced UX）。
- 不追求所有瀏覽器一致體驗。
- 不重做整個 prompt-input editor 架構。

## Decisions

- Decision 1: 採 browser-only MVP，直接重用 `packages/app/src/utils/speech.ts`，不引入後端 STT。理由：最快可驗證，且現有 infra 已在 repo 中。
- Decision 2: 語音 transcript 必須回寫到既有 prompt ownership 路徑，而非在 DOM 外另維護一份 shadow text。理由：避免 editor 與 `prompt.current()` 雙重真相。
- Decision 3: unsupported/error path 明確顯示不可用或失敗狀態，不做 silent fallback。理由：符合 repo fail-fast 原則。
- Decision 4: 先以 prompt footer mic control 進行整合，而不調整 session page 或全域 settings。理由：最貼近目前輸入行為與最小 UX 範圍。
- Decision 5: iPhone / Android 只要 capability detection 命中，就直接啟用與桌面相同的 speech recognition 路徑；僅在 capability 不成立時顯示 unsupported。理由：避免多餘路徑與誤設計。
- Decision 6: route selection 必須由 `prompt-input` 內的顯式 capability policy 分流，且一旦啟動不可 silently switch。理由：避免混淆 contract。

## Data / State / Control Flow

- Browser capability flow:
  - `prompt-input.tsx` 建立 speech helper -> 呼叫 `speech.isSupported()` 決定 mic control 是否可操作/顯示 unsupported state。
- Recording flow:
  - user click mic -> `speech.start()` -> helper 進入 recording state -> `prompt-input` 顯示錄音中 UI。
- Transcript flow:
  - browser speech result -> `speech.ts` 更新 `committed/interim` -> `prompt-input` 根據 speech state 產生 editor/prompt mutation -> final transcript 寫回 canonical prompt state。
- Cleanup flow:
  - user stop / recognition end / component cleanup -> `speech.stop()` -> interim 清空 -> 保留 final committed text。
- iPhone / Android capability flow:
  - user tap mic -> `prompt-input` checks `SpeechRecognition` / `webkitSpeechRecognition` and platform capability -> if supported, start the same speech recognition path as desktop.
- Unsupported flow:
  - if capability detection fails, prompt input must expose explicit unsupported state; no silent fallback.
- Route selection policy:
  - route selection is capability-based and only chooses the shared speech path when support is present; otherwise it selects unsupported state.
  - the decision must be visible in control state and never silently switch after recording starts.
- Boundary:
  - 所有狀態都停留在 browser/client；不跨到 `packages/opencode/src/server/**`。

## Risks / Trade-offs

- Editor integration risk -> `contenteditable` 與語音文字插入可能干擾 cursor/history/IME；需偏向可驗證、最少 mutation 的整合策略。
- Browser inconsistency -> iPhone / Android may or may not expose the API depending on environment; use explicit capability detection and unsupported UI.
- UX trade-off -> route selection should stay simple and capability-driven; this avoids inventing extra paths.
- State duplication risk -> 若直接操作 DOM 而不回寫 prompt state，會造成送出內容與畫面不一致；因此設計上禁止雙重真相。

## Critical Files

- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/utils/speech.ts`
- `packages/app/src/utils/runtime-adapters.ts`
- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zht.ts`
- `packages/app/src/components/prompt-input/submit.test.ts`
- `docs/events/event_20260408_webapp_voice_input_mvp.md`

## Supporting Docs (Optional)

- `specs/architecture.md`
- `docs/events/event_20260312_web_footer_autonomous_provider_toggle.md`
- `docs/events/event_20260303_webapp_runtime_rearchitecture.md`
