# Event: apply_patch prompt hardening

## 需求

- 檢查 lazy loader 的 system prompt。
- 補強 `apply_patch` 的 tool call prompt，改成反面約束：除非上一個動作就是讀該檔案，否則不要修檔。

## 範圍

### IN

- `packages/opencode/src/tool/apply_patch.txt`
- `packages/opencode/src/session/prompt/enablement.json`
- `templates/prompts/enablement.json`
- `templates/prompts/SYSTEM.md`

### OUT

- 不改 `apply_patch` runtime 行為本身
- 不改其他工具的 execution semantics

## 任務清單

- [x] 定位 lazy loader 與 apply_patch prompt 來源
- [x] 補強 apply_patch 描述文字，改成反面禁止句
- [x] 同步 runtime/template prompt registry
- [x] 執行最小驗證並記錄 architecture sync

## Debug Checkpoints

### Evidence

- lazy loader system prompt 的 `<deferred-tools>` 摘要來自 `packages/opencode/src/tool/tool-loader.ts`，其 summary 直接抽取 deferred tool description 首段。
- `apply_patch` 的描述文字來自 `packages/opencode/src/tool/apply_patch.txt`。
- runtime/template 的能力總表另由 `packages/opencode/src/session/prompt/enablement.json` 與 `templates/prompts/enablement.json` 提供能力摘要。

### Implementation

- `packages/opencode/src/tool/apply_patch.txt`
  - 第一段改成更強硬的 hard requirement：除非上一個動作就是 `read` 該檔案，否則不可 patch。
- `packages/opencode/src/session/prompt/enablement.json`
  - 更新 `apply_patch` capability 文案與 `last_updated`。
- `templates/prompts/enablement.json`
  - 同步相同 capability 文案與 `last_updated`。
- `templates/prompts/SYSTEM.md`
  - 在 File Operations 規則中補一條 `apply_patch` 反面禁止句約束。

## Validation

- `python3 -c 'import json; json.load(...); json.load(...); print("enablement json ok")'` ✅
- Architecture Sync: Verified (No doc changes)
  - 依據：本次變更是 prompt / tool instruction hardening，未改動模組邊界、runtime data flow、state machine 或工具執行邏輯。
