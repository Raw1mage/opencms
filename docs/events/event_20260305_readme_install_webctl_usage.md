# Event: README 強化 install/webctl 與 TUI/Web/Desktop 使用指南

Date: 2026-03-05
Status: Done

## 1) 需求

- 使用者要求：以中文更新 `README.md`，明確強調 `install.sh` 與 `webctl.sh` 的定位與用法。
- 使用者要求：補強三種產品面向（TUI / Web App / Desktop）的實際操作路徑。

## 2) 範圍 (IN/OUT)

### IN

- 重寫 README 第 8/9 節（初始化與使用方式）。
- 新增快速流程與角色分工，降低新使用者混淆。
- 對齊 web runtime 單一啟動入口原則（`webctl.sh`）。

### OUT

- 不修改 runtime 程式碼與 shell script 行為。
- 不變更 `install.sh`/`webctl.sh` 實作，只更新文件說明。

## 3) 任務清單

- [x] 更新 `README.md`：強化 `install.sh` 與 `webctl.sh` 職責分工。
- [x] 更新 `README.md`：加入 TUI / Web / Desktop 的快速操作路徑。
- [x] 更新 `README.md`：補充 Web 管理命令與重啟建議。
- [x] 修正文案中舊路徑描述（`opencode.env` -> `opencode.cfg`）。

## 4) Debug Checkpoints

### Baseline

- README 雖有 install 與 webctl 說明，但重點分散，首次使用者不易掌握「先安裝、再啟動、再管理」流程。
- Web/TUI/Desktop 指令有列出，但未形成清晰入口層級。

### Execution

- 以「角色分工 + 推薦快速流程」重構第 8/9 節。
- 明確標示：
  - `install.sh` = 初始化
  - `webctl.sh` = Web 唯一控制入口
  - `bun run dev` = TUI
- Desktop 區段補上 `--with-desktop` 先決建議。
- 新增操作建議，避免混用啟動命令。

### Validation

- 文件變更檢查：`README.md` 完成中文重寫與重點強化。 ✅
- 本次僅文檔調整，未觸及程式執行邏輯，無需額外程式測試。 ✅
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅屬使用指引呈現重構，未改變架構邊界、模組責任、資料流與 runtime 合約。
