# Event: Tool Invocation Centralization

Date: 2026-02-13
Status: Planning

## 1. 需求分析

- **現狀**: 工具調用邏輯 (Plugin hooks, Session Part 更新, 錯誤處理) 散落在 `packages/opencode/src/session/prompt.ts` 中。
- **目標**: 建立統一的 `ToolInvoker` 中控器，降低 `prompt.ts` 的複雜度，並確保所有工具調用的一致性。

## 2. 執行計畫

- [ ] 建立 `packages/opencode/src/session/tool-invoker.ts`。
  - 定義 `ToolInvoker.execute` 方法。
  - 整合 `Plugin.trigger("tool.execute.before/after")`。
  - 整合 `Session.updatePart` 狀態管理。
  - 封裝 `Tool.Context` 的初始化。
- [ ] 遷移 `prompt.ts` 中的 `TaskTool` 調用邏輯。
- [ ] 遷移 `prompt.ts` 中的一般工具 (Normal Tools) 調用邏輯。
- [ ] 驗證工具執行流程與 Plugin 鉤子是否正常運作。

## 3. 關鍵決策

- **抽離邏輯**: 確保 `prompt.ts` 只負責對話循環與狀態機，不參與具體的工具執行細節。
- **相容性**: 維持現有的 `Tool.Context` 介面，避免破壞現有工具。

## 4. 遺留問題 (Pending Issues)

- 暫無。
