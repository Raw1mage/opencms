#### 功能：bun run install 自動安裝 CLI binary

**需求**

- 讓開發者可以只透過 `bun run install` 建構一次 native binary 並安裝到系統的 `bin` 目錄。
- 專案全面轉向 XDG 標準：將原本散落在 `~/.opencode/` 的檔案融入 Linux/macOS 的 XDG 生態系（Config, Data, State, Cache）。
- `bun run install` 自動將 `templates/` 的基準配置初始化到 XDG Config 目錄（`~/.config/opencode/`）。
- 強化 `script/install.ts`：實作 XDG 感知的 `cleanupToCyclebin()`，將 `~/.opencode/` 及各 XDG 目錄中的雜物清理至 `cyclebin`。

**範圍**

- IN：`script/install.ts`、`package.json` 的 `scripts`、`README.md` 安裝說明、`docs/DIARY.md` 索引。
- OUT：不變動發行版 packaging（deb/rpm/brew）內容。

**方法**

- 新增 `script/install.ts` 以 Bun 執行，依照平台/架構組出 dist 目錄名稱，執行 `bun run build --single --skip-install` 後將 binary 拷貝進目標 bin 目錄，並處理權限或路徑覆寫的例外。
- 修改 `src/global/index.ts`：將 `Global.Path.user` 重定向至 XDG Config 目錄，並確保所有路徑（Data, State, Cache）符合標準。
- 修改 `src/util/debug.ts` 與 `image-saver.ts`：移除對 `~/.opencode/` 的硬編碼，改用 `Global.Path.log` 與 `Global.Path.data`。
- 修改 `templates/manifest.json` 與 `install.ts`：使安裝流程全面適應 XDG 目錄結構（Config, Data, State）。
- 強化 `script/install.ts`：支援依據 Manifest 的 `target` 分發檔案，並擴大 `cleanupToCyclebin()` 清理範圍。
- 同步 `src/global/index.ts`：將執行期的自癒初始化邏輯與 Manifest 對齊。
- README 補充 XDG 目錄結構說明。
- 在主 `package.json` 新增 `install` script，讓使用者可以透過 `bun run install` 觸發整個流程。
- 在 `docs/DIARY.md` 新增索引紀錄本次事件。

**任務**

1. [x] 新增 `script/install.ts`，實作建置後自動複製到系統 bin 的邏輯。
2. [x] 擴充 `script/install.ts`，把 `templates/` 的檔案依循 `~/.opencode/` 結構初始化到使用者目錄。
3. [x] 實作 `cleanupToCyclebin()` 邏輯並整合進 `install.ts`。
4. [x] 重構 `templates/` 與 `src/global/index.ts` 的路徑對應。
5. [x] 在 `package.json` 暴露 `bun run install` 腳本。
6. [x] 更新 `templates/manifest.json` 為每個項目指定 XDG `target` (config/data/state)。
7. [x] 修改 `script/install.ts` 以支援多目標分發。
8. [x] 更新 `src/global/index.ts` 的初始化邏輯以符合 XDG 分類。
9. [x] README 補充 `bun run install` 的使用說明與 XDG 目錄行為。
10. [x] 更新 `docs/DIARY.md` 索引與本事件紀錄。

**變更紀錄**

- 修正 `src/util/debug.ts` 的 Global 匯入路徑，避免 dev 啟動時找不到模組。
- 修正 `src/config/config.ts` 在缺少 opencode.json 時的讀取守衛，避免 ENOENT 中斷啟動。
- 補上 `~/.opencode/accounts.json` 一次性搬遷至 `~/.config/opencode/accounts.json` 的流程，避免帳號遺失。

**待解問題**

- 無。
