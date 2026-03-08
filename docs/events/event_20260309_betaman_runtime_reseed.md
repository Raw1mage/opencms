# Event: Betaman runtime reseed

Date: 2026-03-09
Status: Done

## 需求

- 清空 betaman 的 runtime 資料。
- 以 pkcs12 的 runtime 檔案樹重新複製：
  - `~/.config/opencode`
  - `~/.local/share/opencode`
  - `~/.local/state/opencode`

## 範圍

### IN

- `/home/betaman/.config/opencode`
- `/home/betaman/.local/share/opencode`
- `/home/betaman/.local/state/opencode`
- `/home/pkcs12/.config/opencode`
- `/home/pkcs12/.local/share/opencode`
- `/home/pkcs12/.local/state/opencode`

### OUT

- 不處理 `~/.local/cache/opencode`
- 不修改 cms repo 內容

## 任務清單

- [x] 確認 source/target 路徑與執行中程序
- [x] 清空 betaman runtime target paths
- [x] 從 pkcs12 複製 config/share/state 到 betaman
- [x] 驗證 ownership 與目錄狀態

## Debug Checkpoints

### Baseline

- 使用者明確要求以破壞式方式重建 betaman runtime。
- 本輪僅重建 config/share/state 三個 runtime 路徑。

### Execution

- 確認 `betaman` 無執行中 `opencode` process。
- 刪除並重建：
  - `/home/betaman/.config/opencode`
  - `/home/betaman/.local/share/opencode`
  - `/home/betaman/.local/state/opencode`
- 由 `pkcs12` runtime 複製資料到 `betaman`：
  - config/share/state 全量複製
  - `skills/` 特別採用 **dereference symlink** 方式複製內容，避免把 `pkcs12` 的 shared skills symlink 原封不動帶給 `betaman`
- 目標 ownership 統一設為 `betaman:betaman`。

### Validation

- `sudo -u betaman -H bash -lc 'ls -ld ~/.config/opencode ~/.config/opencode/skills ~/.local/share/opencode ~/.local/state/opencode'` ✅
- `sudo -u betaman -H bash -lc 'stat -c "%U %G %a %n" ~/.config/opencode ~/.config/opencode/accounts.json ~/.config/opencode/skills ~/.local/share/opencode ~/.local/state/opencode'` ✅
- 驗證結果：
  - `~betaman/.config/opencode` 存在，owner=`betaman`
  - `~betaman/.config/opencode/accounts.json` 為 `600`
  - `~betaman/.config/opencode/skills` 現在是實體目錄，不是外部 shared symlink
  - `~betaman/.local/share/opencode` 與 `~betaman/.local/state/opencode` 已存在且 owner=`betaman`
- Architecture Sync: Verified (No doc changes)
  - 本次為 runtime home reseed / operational reset，未改變 repo architecture contract。
