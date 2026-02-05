# Code Review: OpenCode System

## Feature: thoughtSignature Plugin / QUOTA Cleanup (2026-02-03)

### Requirements

- 確認 `src/plugin/google-api/plugin.ts` 存在並於 `src/plugin/index.ts` 註冊，確保 Gemini tool calls 注入 `thoughtSignature`。
- 移除 `src/session/processor.ts` 中為模擬 QUOTA_EXHAUSTED/INVALID_ARGUMENT 而加入的暫時程式碼。
- 修復既有 LSP/型別錯誤（`src/config/config.ts`, `src/task/task.ts`）。
- 通過型別檢查與測試：`bun run typecheck`、`bun test`。

### Scope

- IN: `src/plugin/google-api/plugin.ts`, `src/plugin/index.ts`, `src/session/processor.ts`, `src/config/config.ts`, `src/task/task.ts`, `PLANNING.md` 更新。
- OUT: 其他功能開發、文件以外之行為變更。

### Approach

1. 先檢查並記錄現有 plugin 設定與註冊狀態。
2. 移除 QUOTA 模擬程式碼，恢復實際邏輯。
3. 修正型別/LSP 錯誤，確保與目前實作一致。
4. 執行 `bun run typecheck`、`bun test` 驗證。
5. 必要時更新 DIARY 摘要（若有實質變動）。

### Tasks

1. [ ] 驗證 thoughtSignature 插件存在並已註冊
2. [ ] 移除 `src/session/processor.ts` 的 QUOTA 模擬
3. [ ] 修復 `config.ts` / `task.ts` 型別錯誤
4. [ ] 執行 `bun run typecheck`
5. [ ] 執行 `bun test`

### Open Questions

- 是否需同步更新 DIARY 以紀錄此次修復？

---

## Feature: Dialog 主會話 + Sub-session 分工 (2026-02-03)

### Requirements

- Main session 的 dialog agent 以對話/規劃/分派為主，允許處理瑣碎修補。
- 任務分類後以 sub-session 分工（可再分派、可使用工具）。
- Sub-session 模型選擇：以 Favorites 為候選池，搭配 rotation3d 選擇可用模型。
- 依任務特性與工程規模挑選角色與模型量級（大型任務→高階模型）。
- 分工不固定角色，依任務動態決定；支援關鍵字觸發。

### Scope

- IN: `src/session/prompt.ts`, `src/agent/agent.ts`, `src/account/rotation3d.ts`（調用）、`src/config/config.ts`（設定）
- IN: `AGENTS.md`（補充 model 特長/分工策略說明）
- OUT: CLI/TUI 顯示調整、Provider/Rotation 核心行為變更。

### Approach

1. 定義 dialog agent 的行為與分派策略（分類、規模評估、角色決定）。
2. Main session 生成 subtask parts，啟動 sub-session；允許 sub-session 再分派與使用工具。
3. 模型選擇：以 Favorites + rotation3d 取得可用模型向量，映射到子任務角色。
4. 在 AGENTS.md 建立模型特長/任務對應表與分工準則。

### Tasks

1. [ ] 調整 dialog agent 與 sub-session 分派邏輯
2. [ ] 接上 Favorites + rotation3d 的模型挑選
3. [ ] 任務分類 → 角色/模型量級映射
4. [ ] 更新 AGENTS.md 模型特長/分工策略
5. [ ] 驗證 sub-session 允許工具與再分派

### Open Questions

- 角色與模型量級映射的預設規則是否要可配置？

## Requirements

- **Scope**: Comprehensive review of the entire system, including:
  - Architecture & Design
  - Antigravity Plugin
  - Session & LLM
  - CLI & TUI
  - Tools & Security
- **Depth**: Comprehensive (Refactoring suggestions, Security audit, Code quality)
- **Goal**: Identify architectural weaknesses, potential bugs, security risks, and code quality issues.

## Approach

I will perform the review in phases, examining key files and patterns for each area.

### Phase 1: Architecture & Core

- **Focus**: Dependency injection, event bus, configuration management, global state.
- **Files**: `src/index.ts`, `src/global`, `src/bus`, `src/config`.

### Phase 2: Antigravity Plugin

- **Focus**: Plugin architecture, hooks, state management, model integration.
- **Files**: `src/plugin/antigravity/**/*`.

### Phase 3: Session & LLM

- **Focus**: Context management, prompt handling, agent loops, error recovery.
- **Files**: `src/session/**/*`, `src/agent/**/*`.

### Phase 4: Tools & Security

- **Focus**: Input validation (Zod), permission checks, command execution safety.
- **Files**: `src/tool/**/*`, `src/permission/**/*`.

### Phase 5: CLI & TUI

- **Focus**: Component structure, state management (SolidJS), event handling, user experience.
- **Files**: `src/cli/**/*`.

## Tasks

1. [ ] Phase 1: Review Architecture & Core
2. [ ] Phase 2: Review Antigravity Plugin
3. [ ] Phase 3: Review Session & LLM
4. [ ] Phase 4: Review Tools & Security
5. [ ] Phase 5: Review CLI & TUI
6. [ ] Compile Final Report (`CODEREVIEW.md`)

## Output

- A detailed `CODEREVIEW.md` file containing findings, severity levels, and specific recommendations for each area.

## Feature: Subagent Monitor Panel

- **Status**: 後端 snapshot `SessionMonitor.snapshot()` 與 `/session/top` API 已完成，下一階段聚焦 TUI side monitor panel 與資料流。
- **Scope**
  - IN: 聚合 session metadata、status、model、requests/tokens 為 `/session/top` 快照，並在 sidebar 加入 monitor panel 提供跳轉。
  - OUT: 歷史 log、CLI 新指令、太過細緻的 provider 內部 telemetry。
- **Approach**
  1. 確認後端 snapshot 包含必要欄位（agent、parentID、status、model/provider、requests、tokens、active tool），並透過 OpenAPI 釋出 `/session/top`。
  2. 重新產生 SDK/OpenAPI 以便 `sdk.client.session.top()` 可用；Sync store 需新增 monitor 欄位並定期刷新快照。
  3. Sidebar 中新增 MonitorPanel，按狀態排序、顯示狀態點、model/provider、requests/tokens、active tool，並支援點擊跳轉 session。
  4. 保持 panel 資料與 bus/監控事件同步（定期 poll 或在 event 觸發時刷新），並說明更新頻率與行為。
- **Tasks**
  1. [x] 定義 snapshot 格式（sessionID、agent、title、status、model/provider、requests、tokens、active tool），確認 Miss/Need。
  2. [x] 透過後端 `SessionMonitor.snapshot()` 聚合所有 session 並新增 `/session/top` route。
  3. [x] 建立後端邏輯並確保 OpenAPI 有對應 schema。
  4. [x] 重新產生 SDK/OpenAPI，讓 `sdk.client.session.top()` 可用，並更新 CLI/Sync typings。
  5. [x] 在 `sync` store 新增 monitor snapshot、定期刷新（例如每 3 秒）並同步至 panel。
  6. [x] 在 sidebar 實作 MonitorPanel（status dot、model/provider、requests/tokens、active tool、點擊跳轉 session）。
  7. [x] 確認 panel 資料與 Bus/Sync event 協作良好，並記錄更新頻率／顯示上限。
- **Open Questions**
  - 是否要限制 panel 顯示列數？目前預計顯示最多 8 筆最活躍的 session。
- 監控 panel 是否以 poll 為主？暫定每 3 秒刷新一次快照以維持即時性。

---

## Feature: Sidebar Monitor 全域 Model 使用 (2026-02-03)

### Requirements

- Sidebar 的 Monitor 需即時顯示所有使用 model 的背景程序：session、sub-session、agent、sub-agent、tool calls。
- 以「全局 model 使用狀況」為核心，整合跨層級的執行中資訊。
- 可在 Monitor 內快速辨識目前正在使用的 model / provider 與所屬層級。

### Scope

- IN: 後端監控快照擴充（跨 session/sub-session/agent/sub-agent/tool calls），SDK/Store 資料流、Sidebar Monitor UI。
- OUT: 歷史紀錄、長期統計、外部 telemetry 服務串接。

### Approach

1. 盤點現有 SessionMonitor 快照與資料源，定義「全域 model 使用」的最小必要欄位（層級、關聯 ID、狀態、model/provider、tool 名稱）。
2. 擴充後端快照或新增端點，聚合所有正在使用 model 的背景程序。
3. 更新 SDK + sync store，提供定期刷新與事件觸發同步。
4. 更新 Sidebar Monitor：分層標示（session/sub-session/agent/sub-agent/tool call），支援依狀態或層級排序。

### Tasks

1. [ ] 釐清資料來源與快照 schema（全局 model 使用的最小欄位）
2. [ ] 後端聚合跨層級的執行中紀錄
3. [ ] 更新 SDK / Store 資料流與刷新策略
4. [ ] 調整 Sidebar Monitor UI（層級標示 + 排序/過濾）

### Open Questions

- 需要顯示的層級標示格式與優先排序規則？
- 是否需要限制顯示筆數或分頁？

---

## 十五、共享測試 Plugin Cache (2026-02-02)

### Requirements

- 建立 `test/shared/plugin-cache`，預先安裝 `@opencode-ai/plugin` 並透過 `.gitignore` 免除 `node_modules` 以及 `.bun`。
- 提供 `script/setup-plugin-cache.ts` 來初始化這個 cache（若 `node_modules` 缺失才會跑 `bun install`）。
- 調整 `Config.installDependencies()`：若 cache 存在就以符號連結取代重新安裝，避免多份 `bun add/install`。
- 在 `package.json` 新增 `prepare:plugin-cache` script，同時讓文件說明「先跑腳本、再跑 bun test」配合 `OPENCODE_TEST_PLUGIN_CACHE` 環境變數。

### Scope

- IN: `test/shared/plugin-cache/*`, `script/setup-plugin-cache.ts`, `package.json` scripts、`src/config/config.ts` 以及 PLANNING/README 的說明。
- OUT: 其他測試或 CI 流程（只需先跑腳本建立 cache 即可）。

### Approach

1. 建立 `test/shared/plugin-cache` 檔案結構，記錄需要的依賴並忽略 `node_modules`/`.bun`。
2. 撰寫 `script/setup-plugin-cache.ts`，檢查 `node_modules` 並在必要時用 `bun install` 建立 cache。
3. 在 `package.json` 中加入 `prepare:plugin-cache` script，好讓 CI/開發者一鍵同步 cache。
4. 更新 `Config.installDependencies()`：偵測 cache，連結至 `node_modules` 並直接返回，除非 cache 不足才執行 `bun add/install`。
5. 補充文件（PLANNING/README）：描述 cache 路徑、env 變數以及使用順序。

### Tasks

1. [x] 建立 `test/shared/plugin-cache`（含 `package.json` + `.gitignore`）
2. [x] 撰寫 `script/setup-plugin-cache.ts`
3. [x] 在 `package.json` 新增 `prepare:plugin-cache` script
4. [x] 讓 `Config.installDependencies()` 使用 cache
5. [ ] 在 PLANNING/README 補充使用說明 + env 變數示例

### Open Questions

- 是否也要在 CI pipeline 裡加一個 `bun run prepare:plugin-cache` 步驟？

---

## Feature: Sidebar Monitor Improvements (2026-02-02)

### Requirements

- **Filter**: Only show "running" processes in the Monitor panel.
  - "Stopped" processes (idle, error) should be hidden.
  - Active states: `busy`, `working`, `retry`, `compacting`, `pending`.
- **Compactness**: Reduce visual space occupied by each entry.
  - Reduce padding.
  - Minimize empty lines.
  - Compact the layout of information.

### Scope

- IN: `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
- OUT: No changes to backend/SDK, just UI filtering and styling.

### Approach

1. Modify `monitorEntries` in `Sidebar` component to filter by status.
2. Refactor the `box` styling for monitor items to reduce padding/gap.
3. Consolidate metadata (model, tokens, reqs) into a single compact line if possible.

### Tasks

1. [x] Implement filtering logic in `monitorEntries` memo.
2. [x] Redesign Monitor item UI for compactness.
