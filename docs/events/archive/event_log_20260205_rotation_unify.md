#### 功能：Model Rotation 統一化與透明化 (階段 1)

**需求**

- 修復 `selectImageModel` 的 accountId 獲取錯誤。
- 讓 `ModelScoring.select` 統一改用 `rotation3d` 的 API。
- 統一 `Toast` 顯示格式為：「**[Fallback: 原因] 來源帳號(模型) → 目標帳號(模型)**」。
- 擴展 Toast 組件寬度以支援長訊息不換行。

**範圍**

- IN：`src/session/prompt.ts`, `src/agent/score.ts`, `src/session/llm.ts`, `src/account/rotation3d.ts`, `src/cli/cmd/tui/ui/toast.tsx`

**方法**

- 修正 `prompt.ts`：修復 accountId 並加入 `debugCheckpoint`。
- 修正 `score.ts`：移除冗餘邏輯，改呼叫 `rotation3d` 的檢查函數。
- 更新 `llm.ts`：優化 Toast 訊息發布格式。
- 修改 `toast.tsx`：調整 CSS/Layout 確保完整顯示明細。

**任務**

1. [x] 建立此事件紀錄
2. [ ] 修改 `src/session/prompt.ts` - 修復 Bug 並導向統一 API
3. [ ] 修改 `src/agent/score.ts` - 統一使用 rotation3d 邏輯
4. [ ] 修改 `src/account/rotation3d.ts` - 擴展 `FallbackCandidate` 資訊
5. [ ] 修改 `src/session/llm.ts` - 更新 Toast 顯示格式
6. [ ] 修改 `src/cli/cmd/tui/ui/toast.tsx` - 擴展訊息寬度

**CHANGELOG**

- 2026-02-05: 初始建立計畫。
- 2026-02-05: 完成階段 1：修復 Bug、統一 API、優化 Toast 與記錄。
- 2026-02-05: 完成階段 2：實作目的性 Rotation、原生能力感知 (capabilities)、任務導向 Toast 與 ModelScoring 整合。
- 2026-02-05: 緊急 Bug 修復：嚴格限制 Rotation 候選模型必須在 Favorites 中，防止非預期模型（如 Anthropic 系列）被自動滾動。
