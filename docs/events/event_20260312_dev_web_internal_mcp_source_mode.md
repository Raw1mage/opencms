# Event: dev web internal MCP source mode

Date: 2026-03-12
Status: Completed

## 需求

- 釐清目前 project-owned internal MCP server 的啟動/停止路徑。
- 讓 `./webctl.sh dev-start` 啟動的 web runtime 在開發模式下，對 internal MCP server 自動改用 Bun/source 啟動，而不是 system binary。
- 保留 internal MCP 的顯式啟用/停用機制，避免因 command 來源切換而失去 lifecycle control。
- 將 `webctl.sh status/flush` 的 orphan 檢查擴到高信心 MCP orphan process。

## 範圍 (IN / OUT)

### IN

- `webctl.sh`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/mcp/index.ts`
- `packages/opencode/test/config/config.test.ts`
- `docs/ARCHITECTURE.md`
- `docs/events/`

### OUT

- 不變更外部第三方 MCP server 的 command strategy
- 不新增 silent fallback / rescue path
- 不改寫既有 MCP OAuth/auth flow

## 任務清單

- [x] 讀取 architecture / 既有 MCP event，確認目前 runtime contract
- [x] 追查 internal MCP command normalization 與 local MCP spawn path
- [x] 為 `webctl dev-start` 增加 internal MCP source-mode 宣告
- [x] 在 config normalization 中加入 internal MCP source/binary deterministic mapping
- [x] 補測試覆蓋 source-mode 與 binary-mode normalization
- [x] 驗證啟停/停用路徑與文件同步
- [x] 擴充 `webctl.sh status/flush` 的 MCP orphan 檢查

## Debug Checkpoints

### Baseline

- `packages/opencode/src/mcp/index.ts` 的 local MCP 透過 `StdioClientTransport` 以 config 內的 `mcp.<name>.command` 啟動。
- `packages/opencode/src/config/config.ts` 目前只會把 repo path normalization 成 `/usr/local/lib/opencode/mcp/<name>` system binary，不會在 dev web runtime 反向映射回 Bun/source。
- MCP shutdown 生命週期統一由 runtime disposal / `ProcessSupervisor.disposeAll()` 收尾，但 internal MCP command 來源沒有 dev/prod mode contract。

### Execution

- 在 `packages/opencode/src/config/config.ts` 新增 internal MCP normalization contract：
  - `OPENCODE_INTERNAL_MCP_MODE=source` 時，`system-manager` / `refacting-merger` / `gcp-grounding` 會被 deterministic 重寫成 `bun <repo>/packages/mcp/...` command。
  - `OPENCODE_INTERNAL_MCP_MODE=binary` 時，會被 deterministic 重寫成 `/usr/local/lib/opencode/mcp/<name>`。
  - `auto` 模式維持既有行為：僅在 repo-path config 且 system binary 存在時，才正規化到 system binary。
- 在 `webctl.sh` 的 source-repo `dev-start` 路徑注入：
  - `OPENCODE_INTERNAL_MCP_MODE=source`
  - `OPENCODE_REPO_ROOT=<repo root>`
- 保留 internal MCP 的既有 lifecycle control：
  - 啟動是否自動連線仍由 `mcp.<name>.enabled` 決定。
  - 執行中的 connect/disconnect 仍走既有 MCP runtime 路徑，不新增 fallback。
- 在 `webctl.sh` 擴充 orphan 掃描：
  - `status` 現在分別顯示 runtime orphan 與 MCP orphan 計數。
  - `flush` 會同時列出並清理 runtime/MCP orphan candidates。
  - MCP orphan 掃描只覆蓋高信心命令樣式：project-owned internal MCP binary/source command，以及目前 resident local MCP 常見的 `memory` / `filesystem` / `fetch` / `sequential-thinking` 命令。
- 補上 `packages/opencode/test/config/config.test.ts` 測試：
  - source mode: system binary command -> bun source command
  - binary mode: repo path command -> system binary command
  - 兩者皆驗證 `enabled` flag 保留。
- 同步 `docs/ARCHITECTURE.md`，將 dev web runtime 的 internal MCP source-mode contract 寫入 deployment/runtime consistency 章節。

### Validation

- `bun test packages/opencode/test/config/config.test.ts` ✅
- `bash -n webctl.sh` ✅
- `git diff -- packages/opencode/src/config/config.ts packages/opencode/test/config/config.test.ts webctl.sh docs/ARCHITECTURE.md docs/events/event_20260312_dev_web_internal_mcp_source_mode.md` ✅
- Architecture Sync: Updated
  - 依據：本輪改變了 dev web runtime 對 project-owned internal MCP 的 command normalization contract，已同步更新 `docs/ARCHITECTURE.md`。
