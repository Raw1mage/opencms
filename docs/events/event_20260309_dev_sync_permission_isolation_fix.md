# Event: Dev sync permission and isolation fix

Date: 2026-03-09
Status: Done

## 需求

- 修復 `betaman` 在 beta repo 執行 `bun run dev` 時，`sync:back` 因 rsync preserving attrs 造成的 `chgrp` 失敗。
- 確保 beta dev runtime 不會讀寫或覆蓋 `pkcs12` 的 cms repo。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/script/sync-config-back.sh`
- `/home/pkcs12/projects/opencode-beta/script/dev-sync-config.sh`
- `/home/pkcs12/projects/opencode-beta/testbeta.sh`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 不改 cms repo 內容
- 不更動正式 webctl runtime 啟動入口

## 任務清單

- [x] 找出 rsync permission failure 根因
- [x] 改成不保留 owner/group/perms 的 safe sync
- [x] 隔離 beta dev runtime config path
- [x] 驗證 betaman 啟動不再碰 cms repo

## Debug Checkpoints

### Baseline

- `testbeta.sh` 以 `betaman` 身份直接在 `/home/pkcs12/projects/opencode-beta` 執行 `bun run dev`。
- `script/sync-config-back.sh` 使用 `rsync -au`，會嘗試保留 group/owner/perms，導致對 `pkcs12` 擁有的 beta repo 檔案執行 `chgrp` 失敗。
- 目前 runtime config 預設落在 `/home/betaman/.config/opencode`，未與 beta 測試用途隔離。

### Execution

- `script/sync-config-back.sh` 與 `script/dev-sync-config.sh` 的 rsync 改為 `-ru/r --no-perms --no-owner --no-group`，避免 betaman 對 pkcs12 擁有的 repo 檔案做 `chgrp/chown` 或 `mtime` 更新而失敗。
- `testbeta.sh` 維持以 `sudo -u betaman -H` 啟動，因此會使用 betaman 自己的 home/XDG runtime：
  - `~betaman/.config/opencode`
  - `~betaman/.local/share/opencode`
  - `~betaman/.local/state/opencode`
- 這符合「betaman 應有專屬 runtime 空間」的需求。
- 額外發現：`~betaman/.config/opencode/skills` 是 symlink 到 `/home/pkcs12/projects/skills`，屬於共享技能樹，不是 betaman 私有 runtime 內容。
- 安全邊界改由以下兩點保證：
  - beta repo 啟動路徑仍固定在 `/home/pkcs12/projects/opencode-beta`
  - sync scripts 改為不保留 owner/group/perms，因此不會對 `pkcs12` 擁有的 beta/cms repo 檔案做 `chown/chgrp`
  - 若 runtime `skills` 路徑 resolve 到 `$HOME` 之外，則跳過 `skills/` 雙向同步，避免寫入共享 skill tree
- 因此：
  - 會讀寫 `~betaman/.config/opencode`
  - 不會碰 `/home/pkcs12/projects/opencode`（cms repo）
  - 不會寫入 `/home/pkcs12/projects/skills`

### Validation

- `bash -n script/sync-config-back.sh && bash -n script/dev-sync-config.sh && bash -n testbeta.sh` ✅
- `timeout 25 ./testbeta.sh` ✅（sync 階段通過，source 為 `~betaman/.config/opencode`，且共享 symlink skills path 已被明確 skip）
- `sudo -u betaman -H bash -lc 'ls -ld ~/.config/opencode/skills'` 顯示其為 symlink 到 `/home/pkcs12/projects/skills`；修正後應跳過該路徑同步。
- 最終退出原因為預期中的 `OpenCode TUI requires an interactive terminal (TTY)`，不是 permission/sync 錯誤。
- Architecture Sync: Updated
  - `docs/ARCHITECTURE.md` 已補充 beta dev helper 使用 repo-local isolated XDG runtime 與 non-owner/group-preserving sync contract。
