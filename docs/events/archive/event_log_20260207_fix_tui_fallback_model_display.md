#### 功能：修復 TUI footer bar 在 fallback 後未顯示正確模型名稱

**需求**

- 當選擇一個模型（如 GPT-5.3 Codex）進行對話時，如果發生 rate limit，系統會自動切換（fallback）到另一個模型（如 claude-sonnet-4-5-thinking）來回答問題。
- 但底部的 footer bar 顯示的模型名稱沒有隨著 fallback 而更新，仍顯示原本選擇的模型。

**範圍**

- IN: `src/session/processor.ts`, `src/cli/cmd/tui/component/prompt/index.tsx`
- OUT: 無

**根本原因**

有兩個問題：

1. **Message 更新未持久化**：在 `SessionProcessor` 中，當 fallback 發生時，`assistantMessage.modelID` 被更新，但沒有立即調用 `Session.updateMessage()` 來持久化。

2. **Prompt footer 同步邏輯缺陷**：`prompt/index.tsx` 中的 effect 使用 `msg.id` 作為同步標記，但 fallback 只更新 message 內容（modelID/providerId），id 不變，導致 effect 提前返回不更新。

**方法**

1. 在 `processor.ts` 的兩個 fallback 切換點添加 `await Session.updateMessage()` 調用，讓 message 的 modelID 更新立即持久化。

2. 在 `prompt/index.tsx` 中，將同步標記從單純的 `msg.id` 改為複合鍵 `${msg.id}:${msg.providerId}:${msg.modelID}`，這樣當 message 內容變化時也會觸發同步。

3. 在 `prompt/index.tsx` 的 `local.model.set()` 調用中添加 `recent: true` 選項，將 fallback 後的模型持久化到 `model.json`，下次啟動時會優先使用這個模型。

**任務**

- [x] 分析 TUI footer bar 模型顯示邏輯 (`src/cli/cmd/tui/routes/session/index.tsx`)
- [x] 追蹤 fallback 機制 (`src/session/processor.ts`, `src/session/llm.ts`)
- [x] 確認 sync 機制 (`src/cli/cmd/tui/context/sync.tsx`)
- [x] 在 fallback 切換點添加 `Session.updateMessage()` 調用
- [x] 修復 prompt footer 的同步邏輯使用複合鍵偵測變化
- [x] 添加 `recent: true` 持久化 fallback 模型選擇

**待解問題**

- 無
