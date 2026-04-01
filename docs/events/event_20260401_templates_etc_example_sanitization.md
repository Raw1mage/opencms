# Event: templates etc example sanitization

## 需求

- 將 `/etc/opencode` 的主要 runtime config 對齊到 repo 既有的 `templates/system/*` 模板。
- 去除機敏值，只保留結構、欄位名稱、註解與 placeholder。

## 範圍

IN:

- `/home/pkcs12/projects/opencode/templates/system/opencode.cfg`
- `/home/pkcs12/projects/opencode/templates/system/opencode.env`

OUT:

- 不提交 `/etc/opencode/*` 真實檔案
- 不保留真實 domain、使用者名稱、OAuth secrets、實機路徑細節
- 不建立第二套 `templates/etc/*.example` 冗餘模板根
- 本次不處理 `google-bindings.json`

## 任務清單

- [x] 讀取 `/etc/opencode/opencode.cfg`
- [x] 讀取 `/etc/opencode/opencode.env`
- [x] 盤點 `templates/system/*` 與新 example 之間的重疊
- [x] 將機敏與機器特定值替換為 `templates/system/*` 內的 placeholder
- [x] 刪除冗餘 `templates/etc/*.example`
- [x] 讀回驗證 `templates/system/*` 不含真實敏感內容

## Debug Checkpoints

### Baseline

- `/etc/opencode/opencode.cfg` 與 `/etc/opencode/opencode.env` 含有實機環境值，不適合直接進 repo。
- repo 內既有 `templates/system/opencode.cfg`、`templates/system/opencode.env`，但 `opencode.cfg` 仍殘留真實 public URL / user-home path 範例，不夠安全。
- 若另外新增 `templates/etc/*.example`，會與 `templates/system/*` 形成雙模板根，造成維護漂移風險。

### Execution

- 決策：以 `templates/system/*` 作為唯一系統部署模板 SSOT，不保留 `templates/etc/*.example` 第二套模板根。
- 更新 `templates/system/opencode.cfg`
  - `OPENCODE_PUBLIC_URL` 改為 `https://your-opencode.example.com`
  - `OPENCODE_SERVER_HTPASSWD` / `OPENCODE_SERVER_PASSWORD_FILE` 註解範例改為 `/home/your-user/...`
- 確認 `templates/system/opencode.env` 已維持 placeholder / 非敏感內容，無需重做。
- 刪除冗餘 `templates/etc/opencode.cfg.example`、`templates/etc/opencode.env.example`。

## Validation

- 讀回 `templates/system/opencode.cfg` ✅
- 讀回 `templates/system/opencode.env` ✅
- 確認無真實 domain、使用者名稱、repo 路徑、Google OAuth secret/client id 原樣留在 repo ✅

## Architecture Sync

- Verified (No doc changes)
- 依據：本次僅新增 release/template 交付樣板，未改變 runtime 架構邊界或資料流。
