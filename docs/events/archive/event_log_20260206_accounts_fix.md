#### 功能：修復 XDG 遷移後的資料完整性問題

**需求**

- 修復 Admin Panel 帳號列表空白的問題
- 修復 `AGENTS.md` 被模板覆蓋導致自訂內容遺失的問題
- 確保所有 OpenAI Codex 相關設定、模型狀態與歷史封存完整搬遷
- 提供 RCA（根因分析）
- 強化自動遷移邏輯，防止「空檔案」或「模板檔案」阻礙遷移

**範圍**

- IN：`accounts.json`, `AGENTS.md`, `openai-codex-*`, `model-status.json`, `cyclebin` 遷移
- IN：`src/global/index.ts`, `src/account/index.ts`, `script/install.ts`, `src/installation/index.ts` 代碼修正
- IN：Bash 安裝腳本與 `test-cleanup.ts` 重構

**方法**

- 使用 `bash` 執行補救性搬遷，恢復遺失的自訂 `AGENTS.md` 與其餘設定檔
- 修正 `src/account/index.ts`：若目標檔案 < 50 bytes 仍執行遷移
- 修正 `src/global/index.ts`：若舊路徑有較大檔案則不寫入模板
- 修正 `script/install.ts`：增加搬遷清單，並允許覆蓋較小的預設檔
- 更新安裝偵測與清理腳本，使其全面感知 XDG 路徑
- **更新 `templates/`**：將目前運作中的 `AGENTS.md`, `opencode.json`, `package.json` 覆蓋回 repo 模板

**任務**

1. [x] 追查解析路徑與環境變數影響
2. [x] 整理 RCA（根因分析）並回報
3. [x] 執行補救性搬遷（AGENTS.md, Codex accounts, Model status, cyclebin）
4. [x] 強化代碼遷移邏輯 (src/account, src/global, script/install)
5. [x] 更新 XDG 標準偵測 (src/installation, Bash scripts, test-cleanup.ts)
6. [x] 將現有 working version 覆蓋回 `templates/` 作為發布模板
7. [x] 重構 `AGENTS.md`：依開發生命週期重新組織內容並統一使用繁體中文

**RCA（根因分析）**

- **現象**：`bun run dev` 後帳號列表為空，且自訂 `AGENTS.md` 變回預設英文版。
- **根因**：
  1. **邏輯衝突**：`global/index.ts` 在啟動時會先檢查檔案是否存在，若不存在則寫入模板。
  2. **遷移中斷**：後續執行的遷移邏輯（`install` 或 `Account.load`）看到檔案「已存在」（其實是剛寫入的模板），便跳過搬遷舊資料的步驟。
  3. **清單不全**：部分設定檔（如 `model-status.json`）未被列入自動遷移清單。
- **影響**：使用者資料看似遺失，實則被存放在舊路徑未被讀取。
- **修復**：引入「內容感知」遷移——若目標檔案顯著小於舊檔案或為空，則強制執行覆蓋遷移。

**待解問題**

- 無
