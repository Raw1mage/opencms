## Requirements

- 使用者要求：既然 install 後的 web runtime 已獨立於 repo 運行，`web-refresh` 也不應再與 repo 有關。
- 目標是讓 `web-refresh` 的 production 語義收斂為單純 restart installed web server。

## Scope

### In

- `webctl.sh` `do_web_refresh()` semantics
- `docs/ARCHITECTURE.md` runtime/deploy boundary sync
- event ledger / validation

### Out

- `dev-refresh` 行為變更
- install/deploy pipeline overhaul
- 實際執行 restart

## Task List

- [x] 確認 `web-refresh` 先前仍試圖從 repo rebuild/deploy frontend
- [x] 將 production `web-refresh` 改為 restart-only alias
- [x] 更新 help text / architecture / event

## Baseline

- production install 已將 binary 與 frontend 安裝到 `/usr/local/*`，runtime 應脫離 repo。
- 先前 `web-refresh` 雖已避免覆蓋 binary，但仍會從 repo `packages/app/dist` 重新部署 frontend，與「installed runtime repo-detached」原則衝突。

## Changes

- `webctl.sh`
  - `do_web_refresh()` 改為直接呼叫 `do_web_restart()`
  - 不再 `load_server_cfg`
  - 不再檢查 clean repo deploy source
  - 不再 build/deploy frontend
  - help text 明確改成：restart installed production service (no repo rebuild/deploy)
- `docs/ARCHITECTURE.md`
  - 補充 `web-refresh` 已改為 repo-detached restart-only semantics

## Decisions

1. install/deploy 與 refresh/restart 必須完全分離。
2. `web-refresh` 不再是 deploy 命令，而是 installed production runtime 的 restart alias。
3. 若未來要 rollout 新 binary/frontend，必須走明確 install/deploy 流程，而不是藏在 `web-refresh` 裡。

## Validation

- 靜態檢查：`do_web_refresh()` 已不再呼叫 build / install / frontend deploy。✅
- 靜態檢查：help text 與 architecture 已與 restart-only semantics 對齊。✅
- Architecture Sync: Verified (Doc updated)

## Next

- 若後續需要 production asset rollout，應設計明確命名的 deploy 命令，避免與 restart semantics 混淆。
