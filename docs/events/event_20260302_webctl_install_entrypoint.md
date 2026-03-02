# Event: add webctl install bootstrap entrypoint

Date: 2026-03-02
Status: Done

## 需求

- 提供 `webctl.sh install` 作為初次安裝入口，讓新使用者不需直接記憶 `install.sh` 參數。
- 明確區分 production / development 安裝模式。
- 同步更新 README 與架構文檔。

## 範圍 (IN/OUT)

### IN

- `webctl.sh` 新增 `install` 指令，委派執行 `install.sh`。
- 支援 `--prod`（預設）與 `--dev`。
- `--prod` 模式自動加上 `--system-init`；`--dev` 不加。
- README、`docs/ARCHITECTURE.md` 文案更新。

### OUT

- 不重寫 `install.sh` 主流程。
- 不變更既有 `web-start/web-stop/web-restart` 與 `dev-*` 行為。

## 任務清單

- [x] `webctl.sh` 增加 `install` 指令與參數解析
- [x] 加入 `install --help` 說明與範例
- [x] README 更新安裝/啟動指令（dev/prod 分流）
- [x] `docs/ARCHITECTURE.md` 更新 `webctl.sh` 角色說明

## Debug Checkpoints

### Baseline

- 初次安裝需手動執行 `install.sh` 並記住 `--system-init` 等參數。
- `webctl.sh` 已具備 dev/prod 控制，但缺少 bootstrap 安裝入口。

### Execution

- 在 `webctl.sh` 實作 `do_install()`，使用 mode-based 委派：
  - `prod`（default）→ `bash install.sh --system-init ...`
  - `dev` → `bash install.sh ...`
- `is_owner_scoped_command` 納入 `install`，保持 repo-owner 一致行為。
- 更新 help 與主命令 dispatch。

### Validation

- `bash -n webctl.sh` 通過。
- `./webctl.sh help` 顯示 `install`、`web-*`、`dev-*` 分流與範例。
- 文檔已反映新的 install 入口與運行模型。
