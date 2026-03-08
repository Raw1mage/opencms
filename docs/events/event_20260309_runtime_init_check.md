# Event: Runtime init check

Date: 2026-03-09
Status: Done

## 需求

- 在 `bun run dev` 啟動前加入 runtime baseline preflight。
- 檢查必要 XDG runtime 目錄/檔案是否存在，缺少時自動由 `templates/` 補齊。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/script/runtime-init-check.ts`
- `/home/pkcs12/projects/opencode-beta/package.json`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 不覆蓋既有使用者 runtime 檔案
- 不改 install manifest contract

## 任務清單

- [x] 實作 runtime-init-check.ts
- [x] 串入 dev/dev:debug/dev:full/dev:perfprobe
- [x] 驗證缺檔時可自動補 baseline

## Debug Checkpoints

### Baseline

- install/init 雖已可透過 manifest 初始化 baseline，但 `bun run dev` 尚未有統一的 runtime preflight。
- 缺檔情況目前散落在 sync script 與 runtime fail-safe 處理，缺少單一 dev 啟動檢查點。

### Execution

- 新增 `script/runtime-init-check.ts`：
  - ensure `config/data/state/cache` 目錄存在
  - 讀取 `templates/manifest.json`
  - 僅在 runtime 缺檔時，把 baseline 檔案從 `templates/` seed 到對應 XDG target
  - 不覆蓋既有使用者資料
- `package.json` 的 `dev/dev:debug/dev:full/dev:perfprobe` 現在都會在真正啟動前先跑 `bun run script/runtime-init-check.ts`
- 明確維持定位：此腳本僅供 dev preflight，production 仍由 `install.sh` / `script/install.ts` 負責 baseline 初始化。

### Validation

- `bun run script/runtime-init-check.ts` ✅
- `bun run --cwd packages/opencode typecheck` ✅
- Architecture Sync: Updated
  - `docs/ARCHITECTURE.md` 已補充 `runtime-init-check.ts` 為 dev-only preflight，而非 production install contract 的替代品。
