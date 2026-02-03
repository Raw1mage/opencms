# DIARY：主要開發知識庫

> 單一真實來源（SSOT）。整合 CHANGELOG / PLANNING / DEBUGLOG，依日期排序，繁體中文維護。

## 目錄

- 2026-02-03：近期變更與規劃
- 2026-02-02：Monitor 與測試快取規劃
- 2026-02-01：Provider 正規化與 Model Health Dashboard
- 2026-01-31：/admin 流程與 Rate limit 體驗修復
- 2026-01-30：Antigravity 通信修復
- 未標日期：CMS 模組化與大型重構規劃（彙總）

---

## 模板（新增條目）

```
## YYYY-MM-DD

### CHANGELOG

- ...

### PLANNING

#### 功能：...

**需求**
- ...

**範圍**
- IN: ...
- OUT: ...

**作法**
1. ...

**任務**
1. [ ] ...

**問題**
- ...

### DEBUGLOG

#### 問題名稱

**問題摘要**
- ...

**根本原因**
- ...

**修復重點**
- ...

**驗證**
- [x] ...
```

---

## 2026-02-03

### CHANGELOG

**來源**：本次變更整理

- 新增 Session Monitor snapshot 與 `/session/top` API，並同步 SDK 型別。
- Sidebar Monitor 僅追蹤目前 session 與子孫 session，2 秒輪詢更新，完成即隱藏。
- Sidebar 移除 Subagents 區塊。
- Session 預設標題改為純時間戳。
- Read 工具在父目錄不存在時改用全域搜尋建議路徑，降低 ENOENT 噪音。

### PLANNING

#### 功能：thoughtSignature 插件 / QUOTA 清理

**來源**：`packages/opencode/PLANNING.md:3`（未提交變更）

**需求**
- 確認 `src/plugin/google-api/plugin.ts` 存在並於 `src/plugin/index.ts` 註冊。
- 移除 `src/session/processor.ts` 的 QUOTA 模擬碼。
- 修復 LSP/型別錯誤（`src/config/config.ts`, `src/task/task.ts`）。
- 通過 `bun run typecheck`、`bun test`。

**範圍**
- IN: `src/plugin/google-api/plugin.ts`, `src/plugin/index.ts`, `src/session/processor.ts`, `src/config/config.ts`, `src/task/task.ts`
- OUT: 其他功能與非文件行為變更

**作法**
1. 盤點 plugin 註冊狀態。
2. 移除 QUOTA 模擬碼。
3. 修正型別/LSP。
4. 跑型別與測試。

**任務**
1. [ ] 驗證 thoughtSignature 插件註冊
2. [ ] 移除 QUOTA 模擬
3. [ ] 修復型別錯誤
4. [ ] `bun run typecheck`
5. [ ] `bun test`

**問題**
- 是否同步更新 DEVLOG？

---

#### 功能：自動多 Subagent 分工與模型選擇

**來源**：`packages/opencode/PLANNING.md:33`（未提交變更）

**需求**
- 非瑣碎任務自動分派 subagent（coding/review/testing/docs）。
- 依 subagent 預設 model 或任務特性選模。
- Monitor 顯示 subagent 與模型資訊。

**範圍**
- IN: `src/session/prompt.ts`, `src/agent/agent.ts`, `src/agent/prompt/*`
- OUT: CLI/TUI 顯示調整、Provider/Rotation 行為變更

**作法**
1. 在 `createUserMessage` 注入分工判斷與 SubtaskPart。
2. 補齊 subagent prompt 與 model 設定。
3. 驗證 Monitor 顯示。

**任務**
1. [ ] 新增/調整 subagent 定義
2. [ ] 分工判斷邏輯
3. [ ] SubtaskPart 帶入 model
4. [ ] 驗證 Monitor

**問題**
- 非瑣碎判斷條件要多保守？

---

## 2026-02-02

### PLANNING

#### 功能：Subagent Monitor Panel

**來源**：`PLANNING.md`（commit 2026-02-02）

**狀態**
- 後端 `SessionMonitor.snapshot()` 與 `/session/top` 已完成，聚焦 TUI panel 與資料流。

**範圍**
- IN: `/session/top` 快照、sidebar monitor panel
- OUT: 歷史 log、CLI 新指令、過細 telemetry

**作法**
1. 確認 snapshot 欄位（agent/parentID/status/model/requests/tokens/active tool）。
2. 生成 SDK/OpenAPI，供 `sdk.client.session.top()` 使用。
3. Sidebar 實作 MonitorPanel（排序、狀態點、點擊跳轉）。
4. 透過 poll 或 event 刷新。

**任務**
- [x] 定義 snapshot 欄位
- [x] 新增 `/session/top`
- [x] 更新 SDK/OpenAPI
- [x] Sync store 加入 monitor
- [x] Sidebar 實作 panel

**問題**
- 顯示上限與刷新頻率（預設 8 筆 / 3 秒）。

---

#### 功能：共享測試 Plugin Cache

**來源**：`PLANNING.md`（commit 2026-02-02）

**需求**
- 建立 `test/shared/plugin-cache`，加速測試依賴。
- `script/setup-plugin-cache.ts`：缺 `node_modules` 時才跑 `bun install`。
- `Config.installDependencies()` 偵測 cache 並用符號連結。
- `package.json` 加 `prepare:plugin-cache`。

**範圍**
- IN: `test/shared/plugin-cache/*`, `script/setup-plugin-cache.ts`, `package.json`, `src/config/config.ts`
- OUT: 其他 CI 流程

**任務**
- [x] 建 cache 結構與 `.gitignore`
- [x] 加 setup script
- [x] 加 `prepare:plugin-cache`
- [x] 使用 cache 連結
- [ ] README/PLANNING 補充說明

**問題**
- 是否在 CI 加 `bun run prepare:plugin-cache`？

---

#### 功能：Sidebar Monitor Improvements

**來源**：`PLANNING.md`（commit 2026-02-02）

**需求**
- 只顯示活躍狀態：`busy`, `working`, `retry`, `compacting`, `pending`。
- 壓縮 UI 間距。

**範圍**
- IN: `src/cli/cmd/tui/routes/session/sidebar.tsx`
- OUT: 後端/SDK

**任務**
- [x] 狀態過濾
- [x] UI 緊湊化

---

### PLANNING

#### 程式碼審查：OpenCode 系統

**來源**：`packages/opencode/PLANNING.md:1`（commit 2026-02-02 19:06 +0800）

**目標**
- 全系統審查：Architecture / Antigravity / Session & LLM / Tools & Security / CLI & TUI

**任務**
- [ ] Phase 1~5 審查
- [ ] 產出 `CODEREVIEW.md`

---

#### Provider Capabilities / Model Family / Transformer Pipeline

**來源**：`PLANNING.md:800`（commit 2026-02-02 07:56 +0800）

**Phase 1：Capabilities**
- 建立 `src/provider/capabilities.ts`
- `llm.ts` 改用 capabilities
- 移除 `isCodex` 等硬編碼判斷

**Phase 2：Model Family**
- `Provider.Model` 加 `family`
- 解析/覆寫 family，取代字串嗅探

**Phase 3：Options Transformer Pipeline**
- 抽離 `transform.ts`
- 各 SDK 模組化 transformer
- 支援 plugin 註冊

**效益**
- 新增 provider 成本下降
- 降低 model 誤判
- 轉換集中易測

**風險**
- 重構範圍大，需分階段與測試

---

## 2026-02-01

### DEBUGLOG

#### Provider 名稱正規化與 Model Health Dashboard

**來源**：`DEBUGLOG.md:1`

**問題摘要**
- Provider 名稱混用 `google` / `google-api`。
- Dashboard 跨進程無法共享。

**根本原因**
- Provider ID 分散且無規範。
- `globalThis` / `Symbol.for` 無法跨進程共享。

**修復重點**
- 統一 provider ID：`anthropic`, `openai`, `google-api`, `gemini-cli`, `antigravity`, `opencode`, `github-copilot`。
- 狀態改用 `~/.local/state/opencode/model-health.json`。
- Dashboard 4 欄表格與快捷鍵（`R` / `C` / `←`）。

**驗證**
- [x] Provider 名稱已統一
- [x] Dashboard 跨進程同步成功
- [x] Rate Limit 倒數顯示正常

---

## 2026-01-31

### DEBUGLOG

#### DialogPrompt 輸入與 Google-API 配置流程修復

**來源**：`DEBUGLOG.md`（2026-01-31）

**問題摘要**
- Enter 清空輸入，流程卡住。

**根本原因**
- `textarea` submit 競爭。
- `Show` 切換未完整重掛載。

**修復重點**
- 移除 `textarea` submit。
- `onContentChange` 快照內容。
- `Switch/Match` + `step`。
- 加入 debug checkpoint。

**驗證**
- [x] Enter 流程順暢
- [x] 日誌可追溯

---

#### /admin Google-API 編輯器與調試鏈完善

**來源**：`DEBUGLOG.md`（2026-01-31）

**問題摘要**
- 新增/刪除不穩、焦點丟失。

**根本原因**
- Dialog 重建、焦點未回復。

**修復重點**
- 改用 `dialog.push` overlay。
- 增加 dialog stack trace / error boundary / key trace。
- Dialog 關閉後自動聚焦輸入框。

**驗證**
- [x] 新增/刪除穩定
- [x] 模型選完可回到輸入

---

#### Rate limit 重導向與草稿保留

**來源**：`DEBUGLOG.md`（2026-01-31）

**問題摘要**
- Rate limit 後需手動導航，草稿易中斷。

**修復重點**
- Rate limit 進入 `retry` 時自動開啟 `/admin` 並定位模型列表。
- 關閉後恢復草稿與游標。

**驗證**
- 🤖 `/admin` 自動開啟
- ✏️ 草稿與游標可恢復

---

### PLANNING

#### CMS 模組化重構計畫（核心摘要）

**來源**：`PLANNING.md:1`（commit 2026-01-31 17:15 +0800）

**依賴關係**
- /admin TUI 依賴 Account Module 與 Google Provider Suite
- cms Auth patch 至 origin/dev

**設計決策**
- Provider 維持 `antigravity`、`gemini-cli` 獨立。
- Auth 改以 Account 模組為單一來源。
- Rate Limit 以 Toast + Favorites 自動切換。
- `/admin` 完整管理，`/provider` 保留，`/accounts` 退役。

**Account System**
- API：`Account.list/add/remove/setActive/getActiveInfo/forceFullMigration`
- 旋轉：`getNextAvailable/recordSuccess/recordRateLimit/recordFailure/isRateLimited/getMinWaitTime/getRotationStatus`

**Google Provider Suite**
- `google-api`（API Key）/ `gemini-cli`（OAuth）/ `antigravity`（OAuth + rotation）
- 目的：分散配額、維持多帳號輪替

**Admin TUI**
- 三層導覽：Root / Accounts / Models
- `/admin` 為主、`/models`/`/provider` 保留

---

#### Auth 系統統一

**來源**：`PLANNING.md:210`（commit 2026-01-31 17:15 +0800）

**差異**
- origin/dev：`auth.json` 單帳號
- cms：`accounts.json` 多帳號

**策略**
- `accounts.json` 為唯一來源
- 啟動時強制遷移 `auth.json`（備份後移除）

---

#### 跨模型相容性處理

**來源**：`PLANNING.md:370`（commit 2026-01-31 17:15 +0800）

**問題**
- Gemini/Claude 的 thinking signature 互相污染

**策略**
- 在 `LLM.stream()` 統一入口做 cross-model sanitize

---

#### Rate Limit 處理策略

**來源**：`PLANNING.md:405`（commit 2026-01-31 17:15 +0800）

**行為**
- Toast 通知 → Favorites 自動切換 → 不可用時提示手動
- Gemini 優先在 Google Provider Suite 內輪替

---

## 2026-01-30

### DEBUGLOG

#### Antigravity 模型通信修復

**來源**：`DEBUGLOG.md`（2026-01-30）

**問題摘要**
- 版本錯誤、請求卡住、簡單訊息無回應。

**根本原因**
- 版本陣列含舊版（隨機挑選）。
- Gemini transform 未套用。
- 硬編碼 debug log 干擾。

**修復重點**
- 固定版本 `1.15.8`。
- 補齊 Gemini transform 檢查與參數。
- 移除硬編碼 `console.log`。
