#### 功能：修改建置與安裝流程以符合 XDG 規範

**需求**

- 修改 `bun run build` / `bun run install` 的工作流程。
- 預設安裝路徑由 `/usr/local/bin` 改為 XDG 相容路徑（通常為 `~/.local/bin`）。
- 避免在非必要時需要 `sudo` 權限。

**範圍**

- IN：`script/install.ts`, `README.md`, `README.zht.md`, `src/global/index.ts` (確認 XDG 支援)。
- OUT：Dockerfiles (容器內部仍應使用系統路徑 `/usr/local/bin`)。

**方法**

- 在 `script/install.ts` 中，將 Unix 系統的預設 `installDir` 改為 `path.join(os.homedir(), ".local/bin")`。
- 優先讀取 `XDG_BIN_HOME` 或 `XDG_BIN_DIR` 環境變數。
- 更新文件中的安裝指引。

**任務**

1. [x] 修改 `script/install.ts` 中的 `installDir` 決定邏輯。
2. [x] 檢查 `src/global/index.ts` 是否有需要配合的地方（目前看來已妥善處理資料目錄）。
3. [x] 更新 `README.md` 及其繁體中文版的安裝路徑說明。
4. [x] 驗證變更。 (已更新內部腳本以動態解析二進位路徑)

**待解問題**

- 是否需要自動將 `~/.local/bin` 加入 PATH？（通常由使用者或系統處理，Agent 建議僅提供提示）。
- Dockerfile 是否真的不需要動？（保持系統級別安裝在 `/usr/local/bin` 是容器的最佳實踐）。
