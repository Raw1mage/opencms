# Event: webctl status mcp orphan scan fix

Date: 2026-03-12
Status: Done

## 1) 需求

- 在延續 `webctl restart -> stop -> flush -> start` 工作時，`./webctl.sh status` 出現 awk 語法錯誤。
- 使用者同時觀察到系統中有獨立 `opencode` binary 正在執行，要求釐清 dev mode 是否也會改用 binary 跑 MCP。

## 2) 範圍 (IN/OUT)

### IN

- `/home/pkcs12/projects/opencode/webctl.sh`
- 本 event

### OUT

- 不變更 MCP runtime 選路策略
- 不主動 kill 既有 `opencode` binary session

## 3) Debug Checkpoints

### Baseline

- `./webctl.sh status` 正常顯示 dev runtime，但在 orphan MCP candidate 掃描時噴出 awk syntax error。
- `ps` 顯示：
  - dev web runtime 使用 `bun ... packages/opencode/src/index.ts web`
  - dev web child MCP 使用 `bun packages/mcp/system-manager/src/index.ts` / `bun packages/mcp/refacting-merger/src/index.ts`
  - 另有獨立 `opencode` binary 與 `/usr/local/lib/opencode/mcp/*` 進程存在，ppid 不屬於 dev web runtime。

### Root Cause

- `list_orphan_mcp_candidates()` 的 awk 條件式使用多行賦值/多行 `if (...)` 寫法，當前 awk 實作無法解析，導致 `status` / `flush` 觀測路徑報錯。
- dev web runtime 已明確帶 `OPENCODE_INTERNAL_MCP_MODE="source"`，因此 dev path 下 internal MCP 應使用 repo source bun entry，而不是 system binary。
- 那顆獨立 `opencode` binary 屬於另一個獨立 session / CLI/TUI runtime，不是當前 dev web 直接拉起的 child。

### Execution

- 將 awk 條件改為單行布林表達式，避免 parser 對多行條件誤判。
- 驗證：
  - `./webctl.sh status` 不再出現 awk error
  - `./webctl.sh flush --dry-run` 可正常列出/確認 orphan 候選

### Validation

- ✅ `bash -n /home/pkcs12/projects/opencode/webctl.sh`
- ✅ `bash /home/pkcs12/projects/opencode/webctl.sh status`
- ✅ `bash /home/pkcs12/projects/opencode/webctl.sh flush --dry-run`
- 結果：目前 `No orphaned webctl/opencode/MCP candidates found`
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅修正 operational scan helper，未改動架構邊界或 runtime contract
