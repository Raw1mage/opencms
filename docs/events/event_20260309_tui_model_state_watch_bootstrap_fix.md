# Event: TUI model state watch bootstrap fix

Date: 2026-03-09
Status: Done

## 需求

- 修復 beta TUI 在 `~/.local/state/opencode/model.json` 不存在時直接 `watch(...)` 導致啟動崩潰。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/cli/cmd/tui/context/local.tsx`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 不改 workspace domain 設計
- 不改 betaman runtime reseed 內容

## 任務清單

- [x] 重現並確認 crash 根因
- [x] 補 model.json bootstrap/fail-safe
- [x] 驗證 TUI 不再因缺檔崩潰

## Debug Checkpoints

### Baseline

- `watch('/home/betaman/.local/state/opencode/model.json')` 在檔案不存在時直接拋 `ENOENT`。
- betaman runtime 被重建後，`~/.local/state/opencode/model.json` 目前缺失，可穩定重現 crash。

### Execution

- `packages/opencode/src/cli/cmd/tui/context/local.tsx` 改為在讀取/監看 `model.json` 前先：
  - `mkdir -p ~/.local/state/opencode`
  - 若 `model.json` 不存在則寫入空的 model-state JSON
- `watch(model.json)` 改為在 bootstrap 完成後再掛上，並使用可選 watcher cleanup，避免缺檔時直接拋 `ENOENT`。

### Validation

- `bun run --cwd packages/opencode typecheck` ✅
- `sudo -u betaman -H bash -lc 'rm -f ~/.local/state/opencode/model.json'` 後重新執行 `timeout 25 ./testbeta.sh` ✅
- 驗證結果：
  - 不再出現 `watch ... model.json` 的 `ENOENT`
  - 啟動流程可繼續到預期中的 TTY guard
- Architecture Sync: Verified (No doc changes)
  - 本次為 TUI local-state bootstrap robustness 修補，未改變 repo architecture boundary。
