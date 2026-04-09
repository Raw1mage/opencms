# Proposal

## Why

- 使用者希望為 webapp 的文字輸入框新增語音輸入能力，而且手機也要可用。
- 目前 webapp session prompt 只能手動鍵入、貼上或附加圖片/PDF；對於口述 prompt、行動裝置或臨時描述需求的情境，輸入成本偏高。
- codebase 已存在 browser SpeechRecognition 封裝，但這條路在 iPhone Chrome / iOS WebKit 上不可靠；因此原本的 browser-only quick win 必須擴充成雙路方案。

## Original Requirement Wording (Baseline)

- "考慮為webapp的文字輸入框新增語音輸入的功能"
- "同意先有快速版。請啟用planner規劃設計稿"

## Requirement Revision History

- 2026-04-08: 初始需求為評估 webapp 文字輸入框加入語音輸入的可行性。
- 2026-04-08: 經架構盤查後，需求收斂為 browser-only 快速版，優先使用既有 `SpeechRecognition` 封裝，不引入後端 STT 服務。
- 2026-04-10: 使用者補充手機也要可用；原 plan 擴充為桌面即時辨識 + 手機錄音轉寫雙路方案。

## Effective Requirement Description

此需求的有效範圍是：在 webapp session 的文字輸入框中提供一個**雙路語音輸入方案**。

1. 桌面/支援瀏覽器保留 browser-only 的即時語音辨識 MVP，沿用現有前端 `SpeechRecognition` 封裝，將辨識文字安全整合進 `contenteditable` prompt editor 與 prompt state。
2. 手機端（尤其 iPhone Chrome / iOS WebKit）改走**麥克風錄音 + 上傳 + 轉寫**流程，以確保語音輸入可實際使用。
3. 不支援即時辨識的環境不得靜默失敗；UI 需明確顯示當前採用的語音路徑或不可用原因。
4. 維持既有 prompt editor、送出流程、附件流程與 session prompt state 的一致性。

## Scope

### IN

- `packages/app/src/components/prompt-input.tsx` 的語音輸入按鈕、路徑狀態與錄音中 UI。
- 桌面路徑：使用 `packages/app/src/utils/speech.ts` 進行 browser speech recognition。
- 手機路徑：麥克風錄音、音訊 blob 上傳、轉寫結果回寫 prompt state。
- interim / final transcript 與 prompt editor / prompt state 的整合策略。
- i18n 文案、支援檢測、錯誤提示與基本互動保護。
- 最小必要的單元測試與手動驗證計畫。

### OUT

- 非 webapp 介面（TUI、desktop）語音輸入 parity。
- 長期語音產品化（語言切換、標點優化、權限設定頁、push-to-talk advanced UX）。
- 若手機錄音方案後續需要特定 STT provider，供應商選型可延後，不在本次先凍結。
- 跨瀏覽器完全一致的 STT 品質保證。

## Non-Goals

- 不追求所有瀏覽器都可用；本 plan 接受 capability 差異，但手機目標瀏覽器需有可用路徑。
- 不改變 prompt submit protocol、provider graph 或 session runtime contract。
- 不把現有模型 `audio` modality 能力誤當成前端語音輸入功能的依據。

## Constraints

- 必須遵守 fail-fast 原則；不支援時要明確 UI 告知，不做靜默 fallback。
- 既有 editor 為 `contenteditable`，語音文字插入需避免破壞 cursor、history、IME 與 prompt normalization。
- 桌面路徑優先重用現有 `packages/app/src/utils/speech.ts`，不另造第二套 speech state。
- 手機錄音路徑可新增最小必要的前端錄音與後端轉寫邊界，但不得把音訊流程塞回桌面 SpeechRecognition 抽象。

## What Changes

- 在 `prompt-input` footer 工具區加入 mic control 與路徑狀態呈現。
- 桌面路徑維持 speech recognition 即時辨識與 prompt state 回寫。
- 手機路徑新增錄音/上傳/轉寫流程與對應 UI 狀態。
- 新增 browser support gating、permission / error 提示與錄音停止/清理行為。
- 補齊語音輸入相關文案與驗證案例。

## Capabilities

### New Capabilities

- Browser speech-to-text input: 使用者可在支援的 webapp 瀏覽器中透過麥克風直接把語音轉成 prompt 文字。
- Recording state visibility: 使用者可看到是否正在錄音、何時停止、是否可用。
- Fail-fast unsupported handling: 不支援 speech recognition 的瀏覽器可立即得知功能不可用，而非按了沒有反應。
- Mobile voice input path: iPhone / 手機可透過錄音轉寫取得可用的語音輸入能力。

### Modified Capabilities

- Prompt input editing: 既有 prompt editor 從純手動輸入擴充為可接受語音辨識注入文字。
- Prompt footer actions: footer 工具列從附件 + 送出擴充為附件 + 語音 + 送出。

## Impact

- 主要影響 `packages/app/src/components/prompt-input.tsx` 的 UI、state coordination 與 editor mutation。
- 影響 `packages/app/src/utils/speech.ts` 的使用方式與可能的補強，但不應改變其 browser-only 邊界。
- 會新增手機錄音/轉寫的前後端邊界，需補事件紀錄與對應驗證計畫。
- 影響 `packages/app/src/i18n/*.ts` 文案。
- 需補一份 event log 記錄此 MVP 規劃、決策與後續實作驗證。
