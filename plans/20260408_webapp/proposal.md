# Proposal

## Why

- 使用者希望為 webapp 的文字輸入框新增語音輸入能力，先用最快可落地的版本驗證體驗價值。
- 目前 webapp session prompt 只能手動鍵入、貼上或附加圖片/PDF；對於口述 prompt、行動裝置或臨時描述需求的情境，輸入成本偏高。
- codebase 已存在 browser SpeechRecognition 封裝，但尚未接到 `prompt-input` UI；這代表有低風險的 MVP 切入點。

## Original Requirement Wording (Baseline)

- "考慮為webapp的文字輸入框新增語音輸入的功能"
- "同意先有快速版。請啟用planner規劃設計稿"

## Requirement Revision History

- 2026-04-08: 初始需求為評估 webapp 文字輸入框加入語音輸入的可行性。
- 2026-04-08: 經架構盤查後，需求收斂為 browser-only 快速版，優先使用既有 `SpeechRecognition` 封裝，不引入後端 STT 服務。
- 2026-04-08: 使用者同意先做快速版，進入 planner 規劃設計稿階段。

## Effective Requirement Description

此需求的有效範圍是：在 webapp session 的文字輸入框中提供一個 browser-only 的語音轉文字 MVP。功能必須沿用現有前端 `SpeechRecognition` 封裝，將辨識文字安全整合進 `contenteditable` prompt editor 與 prompt state，並明確呈現支援狀態與錄音狀態；不擴充成後端 Whisper/STT provider，也不加入音訊檔案上傳與儲存流程。

1. 在 webapp session prompt input 新增可操作的語音輸入入口。
2. 優先支援 Chromium 類瀏覽器的 Web Speech API / `webkitSpeechRecognition` 快速路徑。
3. 在不支援瀏覽器中 fail fast 並提供明確 UI 提示，而不是靜默 fallback。
4. 維持既有 prompt editor、送出流程、附件流程與 session prompt state 的一致性。

## Scope

### IN
- `packages/app/src/components/prompt-input.tsx` 的語音輸入按鈕與錄音中 UI。
- 使用 `packages/app/src/utils/speech.ts` 進行 browser speech recognition。
- interim / final transcript 與 prompt editor / prompt state 的整合策略。
- i18n 文案、支援檢測、錯誤提示與基本互動保護。
- 最小必要的單元測試與手動驗證計畫。

### OUT
- 後端 STT provider（Whisper、OpenAI audio transcription、自架服務等）。
- 音訊檔錄製、上傳、附件化、保存或回放。
- 非 webapp 介面（TUI、desktop）語音輸入 parity。
- 跨瀏覽器完全一致的 STT 品質保證。
- 長期語音產品化（語言切換、標點優化、權限設定頁、push-to-talk advanced UX）。

## Non-Goals

- 不追求所有瀏覽器都可用；本 MVP 接受 browser capability 差異。
- 不改變 prompt submit protocol、server route、provider graph 或 session runtime contract。
- 不把現有模型 `audio` modality 能力誤當成前端語音輸入功能的依據。

## Constraints

- 必須遵守 fail-fast 原則；不支援時要明確 UI 告知，不做靜默 fallback。
- 既有 editor 為 `contenteditable`，語音文字插入需避免破壞 cursor、history、IME 與 prompt normalization。
- 現有 `packages/app/src/utils/speech.ts` 已存在，MVP 應優先重用，不另造第二套 speech state。
- 只能透過 webapp 前端瀏覽器能力實作，不新增 server API。

## What Changes

- 在 `prompt-input` footer 工具區加入 mic control 與錄音中狀態呈現。
- 將 speech recognition interim / final transcript 整合到 prompt editor 顯示與底層 `prompt.set(...)` 狀態更新。
- 新增 browser support gating、permission / error 提示與錄音停止/清理行為。
- 補齊語音輸入相關文案與驗證案例。

## Capabilities

### New Capabilities
- Browser speech-to-text input: 使用者可在支援的 webapp 瀏覽器中透過麥克風直接把語音轉成 prompt 文字。
- Recording state visibility: 使用者可看到是否正在錄音、何時停止、是否可用。
- Fail-fast unsupported handling: 不支援 speech recognition 的瀏覽器可立即得知功能不可用，而非按了沒有反應。

### Modified Capabilities
- Prompt input editing: 既有 prompt editor 從純手動輸入擴充為可接受語音辨識注入文字。
- Prompt footer actions: footer 工具列從附件 + 送出擴充為附件 + 語音 + 送出。

## Impact

- 主要影響 `packages/app/src/components/prompt-input.tsx` 的 UI、state coordination 與 editor mutation。
- 影響 `packages/app/src/utils/speech.ts` 的使用方式與可能的補強，但不應改變其 browser-only 邊界。
- 影響 `packages/app/src/i18n/*.ts` 文案。
- 需補一份 event log 記錄此 MVP 規劃、決策與後續實作驗證。