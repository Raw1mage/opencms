#### 功能：優化 Rotation3D 避免重複嘗試與加強 Favorites 清理

**需求**

- 解決 rotation3d 在 fallback 時漏傳 `triedKeys` 導致重複嘗試失敗模型的問題。
- 加強 `SessionProcessor` 對「確定不可用模型」的判定，並自動從 favorites 移除。
- 確保 fallback 本身也會被記錄到已嘗試清單中。

**範圍**

- IN：`src/session/llm.ts`, `src/session/processor.ts`, `src/account/rotation3d.ts`
- OUT：不改動 UI 顯示邏輯。

**方法**

- 在 `LLM.handleRateLimitFallback` 中，將 `triedKeys` 傳入 `findFallback`。
- 在 `LLM.handleRateLimitFallback` 成功選中 fallback 後，將其 key 加入 `triedKeys`。
- 擴充 `src/session/processor.ts` 中的 `isModelNotSupportedError` 判斷。

**任務**

1. [x] 建立 event_20260206_rotation_fix.md 計畫文件
2. [x] 更新 docs/DIARY.md 索引
3. [x] 修改 src/session/llm.ts 傳遞 triedKeys 並追蹤 fallback 歷史
4. [x] 優化 src/session/processor.ts 移除 favorites 的判定邏輯
5. [x] 驗證 rotation3d 是否能正確跳過重複失敗的模型

**DEBUGLOG**

- [2026-02-06] 發現 `findFallback` 雖然有 `triedKeys` 參數，但在 `llm.ts` 中調用時完全被忽略。
