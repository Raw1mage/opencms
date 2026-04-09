# Event: webapp voice input bugfix

Date: 2026-04-09
Status: Fixed Locally (Browser smoke still pending)
Related Plan Root: `plans/20260408_webapp/`

## 需求

- 使用者回報 webapp dialog 右下角已可看到 voice input 按鈕，但語音不會轉成文字放入輸入框。
- 使用者同時觀察到 voice input 缺少明確 stop detection，會持續一直聽。

## 範圍 (IN/OUT)

- IN:
  - `packages/app/src/utils/speech.ts` transcript / stop lifecycle 修正。
  - `packages/app/src/utils/speech.test.ts` 最小回歸測試補強。
- OUT:
  - 後端 STT / server route / provider API。
  - `prompt-input` UI 重新設計。
  - 真實瀏覽器 mic E2E 自動化。

## 任務清單

- [x] 讀取既有 plan / event / architecture 文件確認 voice-input 設計契約。
- [x] 檢查 `prompt-input.tsx` 與 `speech.ts` 的 transcript / stop lifecycle。
- [x] 確認 `appendSpeechTranscript()` 本身有走 `prompt.set(...)`，問題重點落在 `speech.ts` 收斂邏輯。
- [x] 修正自然結束與 `no-speech` 時 pending interim 遺失、以及 restart 造成的連續監聽。
- [x] 補上針對自然結束與 `no-speech` 的測試。

## Debug Checkpoints

- Baseline:
  - mic button 已出現，表示 `prompt-input.tsx` 已接上 `createSpeechRecognition()`。
  - 但使用者觀察到 spoken input 沒有進入輸入框，且錄音似乎一直持續。
- Instrumentation / Evidence:
  - `packages/app/src/components/prompt-input.tsx:613` 的 `appendSpeechTranscript()` 會在收到 final text 後執行 `prompt.set(...)`。
  - `packages/app/src/components/prompt-input.tsx:644` 以 `createSpeechRecognition({ onFinal: appendSpeechTranscript })` 接線。
  - `packages/app/src/utils/speech.ts:237` 先前在 `no-speech` 路徑不會收斂 pending transcript，且可能走 restart。
  - `packages/app/src/utils/speech.ts:266` 先前自然 `onend` 後仍可能 restart，未保證把最後 interim 提升為 final。
- Root Cause:
  - 問題不在 `prompt-input.tsx` 的 prompt-state 寫入，而在 `speech.ts` 的 utterance 收斂策略。
  - 當真實瀏覽器只提供 interim、未明確產生 final 時，pending interim 在自然結束或 `no-speech` 錯誤路徑被丟掉，`onFinal` 因此不會被呼叫。
  - 同時 `no-speech` / `onend` 的 restart 邏輯讓錄音狀態看起來一直在聽，造成使用者感知上的「不停機」。
- Fix:
  - 在 `packages/app/src/utils/speech.ts:237` 的 `onerror` 先 `promotePending()`，並在 `no-speech` 路徑直接收斂停止，不再 restart。
  - 在 `packages/app/src/utils/speech.ts:266` 的 `onend` 先 `promotePending()`，再把錄音狀態收斂為停止。
  - 保留單一 prompt-state authority；未新增 fallback。

## Verification

- 通過：`bun test --preload ./happydom.ts ./src/utils/speech.test.ts ./src/utils/runtime-adapters.test.ts`
  - 工作目錄：`/home/pkcs12/projects/opencode/packages/app`
  - 結果：8 pass / 0 fail
- 新增測試覆蓋：
  - recognition 自然結束時會提交 pending interim。
  - `no-speech` 後不會自動 restart，錄音狀態收斂為停止。
- 尚缺：真實 Chromium mic/browser smoke，因此目前只有 unit-level 證據，沒有端到端瀏覽器證據。

## Remaining

- 在真實 Chromium 瀏覽器做一次 voice-input smoke，確認 spoken input 會出現在輸入框中。
- 驗證 mic 停止後 UI 狀態與 tooltip 是否正確收斂。

## Architecture Sync

- Architecture Sync: Verified (No doc changes).
- 依據：本次修正僅收斂 `packages/app/src/utils/speech.ts` 的 client-side speech lifecycle 與測試，未改變長期模組邊界、資料流層級或 server/runtime contract。
