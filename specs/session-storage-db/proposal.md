# Proposal: session-storage-db

## Why

- 目前 session 持久化採「一條訊息一個檔、一個 part 一個檔」的小檔散布結構。長 session 規模大了之後，per-round runloop 必須 list 目錄、逐檔 read info + N 個 part 檔，並對每條訊息做 `JSON.stringify(msg).length / 4` 估 token，造成 2-5 秒級 lag。
- 觀測案例：2253-message session（drawmiat / `ses_22b2490bbffew8oP2yKA56SxOL`）每次按 Enter 後 stop button 浮出延遲 ~2s、思考中讀秒延遲 ~5s。瓶頸是兩層疊加：底層存檔小檔過多 + 上層每輪重複 reload 沒 cache。
- compaction 雖然會把舊歷史壓縮成 anchor，但代價是有損壓縮，會影響後續 LLM 對歷史細節的回憶。使用者希望減少對 compaction 的依賴。
- 即使接下來修「上層每輪共用 snapshot」可以緩解，**底層的小檔結構本身仍是長期 scale 的瓶頸**。

## Original Requirement Wording (Baseline)

- 「我覺得可以做一個 dreaming mode，模仿人類睡覺時重新整理大腦思緒的機制。把歷史中的分塊併成單檔」
- 「其實更長遠來說我是希望全局重構成更好的架構。你覺得 DB 化如何？」
- 「開 plan」

## Requirement Revision History

- 2026-04-29: initial draft created via plan-init.ts
- 2026-04-29: 對話濃縮為兩條主軸：(a) DB 化作為長期架構升級；(b) dreaming mode 作為 idle-time 整理機制 + legacy migration helper

## Effective Requirement Description

1. 把 session 持久化從「目錄 + 大量小檔」改成「每 session 一個 SQLite `.db` 檔」，保留「一個 session = 硬碟上一個東西」的心智模型，rsync 備份不變。
2. 引入 dreaming mode：daemon idle 時背景處理 (a) 把已封存（不再會被高頻寫入）的歷史片段整理進 SQLite；(b) legacy 目錄格式的舊 session 漸進式搬遷。
3. 讀取層提供 dual-track 雙軌相容：新 session 直上 SQLite，舊 session 維持目錄格式，直到 dreaming mode 把它搬完。
   - dreaming mode 觸發條件：(A) daemon 偵測 idle（無活躍寫入）時週期性背景搬遷，每次只挑一個 session；(D) on-touch 不主動搬，使用者打開的舊 session 維持 legacy 路徑直到背景搬遷輪到它。
   - 不做 daemon 啟動 batch（啟動會變慢）。不做 inactivity-timer-based（A 已涵蓋）。
4. 目標：消除 per-round runloop 的多次 disk-list + 上萬次 small-file read，用 indexed query 取代。

## Scope

### IN
- SQLite 為儲存後端，每 session 一個 `.db` 檔（位置取代目前 `~/.local/share/opencode/storage/session/<sid>/`）
- 訊息與 part 的 schema 設計（含 streaming-write 友好的 append model）
- 讀取路徑：`Session.messages()`、`MessageV2.stream()`、`MessageV2.filterCompacted()` 改寫為 SQL 查詢
- 寫入路徑：訊息建立、part 累加、message info 更新都走 transaction
- Dual-track 讀取相容層（同時支援目錄格式與 SQLite 格式）
- Dreaming mode worker：daemon idle 觸發、背景搬遷、安全的「先寫新檔、驗證、再刪舊檔」流程
- 災難恢復：搬遷中途 daemon 崩潰必須能從原檔重來，不丟資料
- Backup / rsync 行為驗證（確保新格式仍可被既有備份腳本帶走）
- Debug CLI：`opencode session-inspect <sid>` 提供 `list` / `show <mid>` / `check` 三個子指令，補回 SQLite 化後失去的 `cat` / `ls` 能力

### OUT
- 跨 session 共用一個全局 DB（單檔粒度仍是 session）
- 改用 server-process DB（Postgres / MySQL 等需另起 daemon 的方案）
- 改變 session 之間的目錄結構（`session_diff/`、`shared_context/`、`todo/` 等其他 storage namespace 不在本次範圍）
- compaction 邏輯本身的修改（壓縮策略不變；只是讀寫底層換了）
- 上層每輪共用 snapshot 的優化（屬於另一條獨立的 hotfix 軸線，與本案並行不衝突）

## Non-Goals

- 不追求極致的查詢能力（cross-session search、analytics 等）。本案目標是「per-session 訪問變快 + 檔案數量可控」，不是建構 session 的 query layer。
- 不引入 ORM。直接寫 SQL，schema 由 plan-builder spec 文件管理。
- 不立即改變 admin panel 或 UI 對 session 的呈現；外部介面保持不變。

## Constraints

- **Bun 內建 SQLite 支援必須足夠**：`bun:sqlite` 已存在，避免新增 npm 依賴
- **Backwards compatibility**：使用者硬碟上現存 session（潛在 GB 級資料）不能被破壞，搬遷必須冪等
- **AGENTS.md 第一條（no silent fallback）**：任何讀取格式不符 / DB 損毀 必須明確報錯，不可靜默退回小檔模式
- **rsync-friendly**：單一 `.db` 檔比目錄+小檔更友善 rsync（單檔 mtime 即可判斷），但要驗證 incremental sync 行為
- **Concurrent access**：per-user daemon 架構下，一個 session 同時只會有一個 daemon 寫；reader（admin panel / TUI / 偶發 CLI）走 SQLite WAL 的多 reader 並行能力即可。不另做 writer queue。
- **Streaming write 不能變慢**：part 串流時每個 delta 都會寫入；當前是 append text part，新格式必須維持 sub-100ms 的 latency

## Disaster Resilience Contract

本案以「正式產品級」為標準，所有五個失敗場景都必須有明確處理：

### DR-1: daemon 寫入中崩潰
- **機制**：SQLite WAL mode；每次 message / part 更新都在 transaction 內完成並立即 commit
- **保證**：daemon 被 SIGKILL / OOM kill 後重啟，最後一筆 committed 寫入仍在；in-flight uncommitted 寫入丟失（與目前小檔架構同等級）
- **驗證**：integration test 模擬寫入中 abort process，重啟後比對

### DR-2: 整台機器斷電
- **機制**：`PRAGMA synchronous = NORMAL`（WAL 模式下的安全預設）
- **保證**：fsync 在 WAL checkpoint 時觸發；極端情況最多丟最後一個未 checkpoint 的 commit
- **拒絕降級到 OFF**：明確不接受「斷電可能損毀整個 .db」的代價；NORMAL 是最低門檻
- **可選升級**：對特別敏感的 session 可在開檔時切到 `synchronous = FULL`（多 ~5ms/write）— 預設不開

### DR-3: .db 檔本身損毀
- **機制**：daemon 啟動時對每個將要使用的 session .db 跑 `PRAGMA integrity_check`；發現問題立刻 escalate（log + Bus event + 拒絕載入該 session）
- **保證**：絕不靜默回錯資料；user 看到明確錯誤訊息，可選擇從備份還原或丟棄該 session
- **不做自動修復**：`.recover` / dump-and-reload 流程是 user-driven，daemon 不主動執行（避免「修了一半變更糟」）

### DR-4: dreaming mode 搬遷中崩潰
- **機制**：三段式 sentinel
  1. 在 session 目錄旁寫 `<sid>.db.tmp`，把舊資料完整寫入
  2. fsync 並跑 `integrity_check` 驗證 row count = 原小檔 message 數
  3. 兩者都通過後 atomic rename → `<sid>.db`，最後再刪除舊 `<sid>/messages/` 目錄
- **保證**：任何階段崩潰下次重啟都能偵測到不完整狀態，**從原小檔目錄重新搬**（原資料未刪 = 永遠有 source of truth）
- **冪等性**：偵測規則：`<sid>/` 目錄存在且 `<sid>.db.tmp` 存在 → 刪 tmp 重做；`<sid>.db` 存在但 `<sid>/` 也存在 → 已搬完只是沒清乾淨，刪 `<sid>/`

### DR-5: SQLite schema 升級失敗
- **機制**：每個 .db 帶 `PRAGMA user_version`；版本不符時跑遷移 SQL 在 transaction 內，失敗整體 ROLLBACK
- **保證**：升級失敗的 session 維持舊版 schema 可用（讀寫降級為唯讀直到 user 介入）
- **強制要求**：每個 schema migration 必須附帶單元測試（從 v_{N-1} 升到 v_N + 反向回滾）

### Cross-cutting: 備份策略不變
- 既有 cron rsync to NAS 流程繼續運作（檔案層備份）
- SQLite 在 WAL mode 下被 rsync 到的瞬間若有 active writer，可能 capture 到 inconsistent state — 但啟動時 integrity_check 會偵測到 → DR-3 路徑接手
- 額外建議（不在本案 scope）：未來可加上 `sqlite3 .backup` 走 SQLite Online Backup API，更乾淨但需新流程

## What Changes

- 新增儲存層：每 session 一個 `<sid>.db` 取代 `<sid>/messages/` 目錄樹
- `MessageV2.stream` / `MessageV2.parts` / `Session.messages` / `MessageV2.filterCompacted` 從 disk-walk 改為 SQL query
- `Storage.list / Storage.read / Storage.write` 對 session-message namespace 路由到 SQLite handle
- 引入 `SessionStorage.open(sessionID)` / `.close()` 連線生命週期管理
- 新背景服務 `DreamingMode`：監聽 daemon idle 信號，逐個 session 搬遷
- 災難恢復標記：搬遷完成寫入 `<sid>.migrated` sentinel，未完成則保留原目錄

## Capabilities

### New Capabilities
- **per-session SQLite store**: 訊息 / part / message info 集中於單檔，indexed by id + parentID + role
- **dreaming mode**: idle-time legacy migration + 未來可擴充至 vacuum / analyze / 健康檢查
- **dual-track reader**: 透明讀取兩種格式直到 dreaming mode 完成搬遷
- **migration sentinel**: 災難恢復 + 重啟冪等性的標記檔

### Modified Capabilities
- `Session.messages(sessionID)`: 從「目錄 walk + N 次 read」改為「single SQL query + 結果組裝」
- `MessageV2.filterCompacted`: token 估計改用 message info 已存 `tokens` 欄位（不再 `JSON.stringify`）
- 寫入熱路徑（`Session.updateMessage` / `Session.updatePart`）：改為 SQL UPSERT in transaction
- backup / restore：仍然是 file-based（rsync `<sid>.db`），但 atomic guarantee 由 SQLite 自己處理

## Impact

- **效能**：per-round runloop 對歷史的訪問從 O(messages × parts) disk read 降到 O(matching rows) SQL scan
- **磁碟空間**：SQLite 比小檔合計通常省 10-30%（去除 filesystem overhead）
- **可觀測性**：`du -sh ~/.local/share/opencode/storage/session/` 變得有意義（單檔），不再是「萬個 inode 的目錄樹」
- **Debug**：原本可以 `ls / cat` 直接看內容，未來要用 `sqlite3 <sid>.db ".tables"` 之類；要評估是否提供 dev CLI 助手
- **外部備份腳本**：cron rsync to NAS 流程不變（仍是檔案層），但 incremental 行為要實測
- **災難恢復**：SQLite 單檔損毀 = 整個 session 損毀；vs. 目前小檔損毀只壞單一 part。這是個 trade-off — 用 WAL + 定期 backup 緩解
- **遷移時間**：全部 session 估計 N 個 × 平均 M MB；dreaming mode 應控制每次只搬一個，避免 IO 影響使用體驗
