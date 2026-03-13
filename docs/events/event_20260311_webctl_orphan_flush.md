# Event: webctl orphan flush

## 需求

- 在 `webctl.sh` 增加可主動清理 orphan `bun`/webctl 背景程序的指令，例如 `flush`。
- 目標是處理 `PPID=1`、已脫離原始父程序鏈、但仍屬於 opencode/webctl 啟動模型的殘留行程。

## 範圍

### IN

- 盤點 `webctl.sh` 目前的 dev web 啟停模型與 PID/port cleanup 行為。
- 新增 orphan 掃描與清理邏輯。
- 新增 `flush` 指令與 help 文案。
- 驗證命中範圍僅限 opencode/webctl 相關 orphan，不波及一般 `bun` 工作流。

### OUT

- 不改 systemd production service 架構。
- 不重寫整體 process supervisor / daemon lifecycle。
- 不清理非 opencode/webctl 類 `bun` 背景程序。

## 任務清單

- [ ] 讀取 `docs/ARCHITECTURE.md` 與 `webctl.sh` 現況。
- [ ] 補上 orphan 掃描函式與 `flush` 指令。
- [ ] 更新使用說明。
- [ ] 執行實測，確認掃描/清理結果。
- [ ] 完成 event Validation 與 Architecture Sync 記錄。

## 決策 / Gate

- 僅清理 `PPID=1` 的 orphan。
- 僅匹配命令列明確屬於本 repo/opencode webctl 啟動鏈的程序：
  - `script -qefc ... OPENCODE_LAUNCH_MODE="webctl" ... bun ... opencode ... web`
  - `bun -e ... /opencode-beta/... Server.listen(...)`
- 預設先送 `TERM`，若短暫等待後仍存活，再升級 `KILL`。
- 不依賴 PID file 作為 orphan 判斷依據，因為 orphan 本質就是脫離原父鏈。

## 驗證計畫

- 用 `ps -eo pid,ppid,etime,stat,cmd` 驗證 `PPID=1` orphan 掃描結果。
- 執行 `./webctl.sh flush` 驗證只清理 opencode/webctl 類 orphan。
- 再次用 `ps` 驗證目標 orphan 是否消失，且其他非目標 `bun` 程序仍在。
- 記錄 Architecture Sync 結果。

## Validation

- `bash -n webctl.sh` -> pass.
- `./webctl.sh flush --dry-run` -> detected 9 flushable orphan candidates:
  - 1 `webctl`-spawned `script -> bun -> MCP/LSP` tree (`PPID=1`)
  - 8 `bun -e ... /projects/opencode-beta/... Server.listen(...)` orphan servers (`PPID=1`)
- `./webctl.sh flush` -> pass. Cleared 9 orphan process trees.
- Post-check:
  - `./webctl.sh flush --dry-run` -> `No orphaned webctl/opencode candidates found`
  - `ps -eo pid,ppid,etime,stat,cmd | awk '$2==1 && /bun|script -qefc/ {print}'` -> no remaining matching orphan `bun` / `script -qefc` rows
- Architecture Sync: Verified (No doc changes).
  - Basis: change is limited to `webctl.sh` operational cleanup surface and does not alter module boundaries, runtime topology, data flow, or state machine contracts documented in `docs/ARCHITECTURE.md`.
