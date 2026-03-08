# Event: Install model state seed

Date: 2026-03-09
Status: Done

## 需求

- 讓 install/init 流程主動建立 TUI model state baseline 檔案。
- 補上 `model.json` 的模板初始化責任，避免首次啟動只靠 runtime 補救。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/templates/manifest.json`
- `/home/pkcs12/projects/opencode-beta/templates/model.json`
- `/home/pkcs12/projects/opencode-beta/script/install.ts`

### OUT

- 不改 workspace runtime 設計
- 不改 install 的敏感檔案覆寫政策

## 任務清單

- [x] 補 state target template entry
- [x] 新增 model.json baseline template
- [x] 驗證 install manifest 會納入該檔案

## Debug Checkpoints

### Baseline

- `script/install.ts` 已具備 manifest-driven XDG 初始化。
- `templates/manifest.json` 目前沒有 `model.json` entry。
- 因此 install 不會建立 `~/.local/state/opencode/model.json`。

### Execution

- 新增 `templates/model.json`，內容為空的 recent/favorite/hidden/variant baseline。
- 更新 `templates/manifest.json`，將 `model.json` 加入 `target: state` 的初始化清單。
- `script/install.ts` 不需額外邏輯修改，因其既有 `installTemplates(entries)` 已支援 state-target manifest entries。

### Validation

- `jq '.entries[] | select(.path=="model.json")' templates/manifest.json` ✅
- `bun -e 'console.log(JSON.parse(await Bun.file("templates/model.json").text()).variant)'` ✅
- `bun run --cwd packages/opencode typecheck` ✅
- Architecture Sync: Verified (No doc changes)
  - 本次為 install template baseline 補齊，未改變 architecture boundary；既有 install/manifest contract 已涵蓋此模式。
