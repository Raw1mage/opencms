# Event: stale interactive runtime cleanup design

Date: 2026-03-12
Status: Phase 1 Implemented

## 1) 需求

- 使用者要求：不要再追究「誰啟動了 opencode binary / MCP child」，而是要建立一套**可判定 stale/orphan interactive runtime 並可安全清理**的完整設計。
- 目標：當使用者不再使用 TUI 或 webapp 時，非 service 型 `opencode` / internal MCP runtime 不應長時間殘留在系統中。

## 2) 問題定義

目前 `webctl.sh` 已有：

- orphan runtime 掃描
- orphan MCP 掃描
- `flush`
- dev restart `stop -> flush -> start`

但現況仍有一個缺口：

> 現有 `flush` 比較偏 **PPID=1 / 高信心 orphan candidate** 清理，還沒有完整覆蓋「interactive runtime 已失去使用者會話意義、但尚未變成單純 PPID=1 orphan」的 stale state。

因此需要把目標從「孤兒程序」提升為：

> **stale interactive runtime cleanup**

也就是：

- 不只處理 orphan
- 也處理已脫離有效 session / TTY / owner ledger / runtime purpose 的互動式 runtime

## 3) 核心設計目標

1. **不追啟動來源，追目前狀態與存活正當性**
2. **不新增模糊 fallback**（禁止 `pkill bun` / `pkill opencode`）
3. **只清 interactive runtime，不碰正式 service runtime**
4. **清理要可觀測、可解釋、可 dry-run**
5. **先分類再清理，避免誤殺**

## 4) Runtime 分類模型（Canonical Classification）

所有命中的 `opencode` / internal MCP 相關進程，先分成四類：

### A. Protected Service Runtime（受保護服務型）

不可由 `flush` 清理。

條件：

- systemd service 管理中（如 `opencode-web.service`）
- 或未來明確宣告為 maintenance daemon / long-lived background service

特徵：

- 有 service owner
- 有明確 unit / supervisor
- 不是互動式 session 附屬程序

### B. Active Interactive Runtime（受保護互動型）

不可由 `flush` 清理。

條件至少其一成立：

- 被 `webctl` 當前 PID ledger 追蹤
- 為當前 active webctl dev runtime tree 成員
- 為當前活躍 TUI session 對應 runtime tree 成員
- 為 active restart worker / maintenance worker tree 成員
- 明確綁定 live TTY / live session，且該 session 仍有效

### C. Restart/Maintenance Ephemeral Runtime（短生命週期受保護型）

可暫時保護，不直接清理。

條件：

- 命中 `_restart-worker`
- 或命中未來明確登記的 maintenance task ledger
- 且未超過 TTL

若超過 TTL 且無進展，降級為 stale candidate。

### D. Stale Interactive Runtime（目標清理型）

這是本設計要處理的主體。

符合下列邏輯：

- 是 `opencode` / internal MCP / local MCP process tree
- 不是 Protected Service Runtime
- 不是 Active Interactive Runtime
- 不是仍在 TTL 內的 Restart/Maintenance runtime
- 且滿足至少一個 stale indicator

## 5) Stale Indicator 設計

以下指標採 **evidence-based scoring**，不是單一條件直接誤殺。

### 高信心 stale 指標

1. `PPID=1`
2. 所屬 root process 無 live TTY
3. 不在任何 active runtime ledger 中
4. 不屬於 systemd service tree
5. restart worker 已完成/失敗，但殘留子樹仍存活

### 中信心 stale 指標

1. root process session leader 已消失，但 descendant 還活著
2. 互動式 `opencode` binary 存在，但沒有對應當前 shell / terminal / TUI attach evidence
3. internal MCP binary/source child 存在，但其 parent runtime 已不在 active set
4. etime 超過門檻，且無任何活躍 owner marker

### 否決型保護指標（有其一就不可直接清）

1. 命中 active webctl PID / backend PID / frontend PID
2. 命中 active TUI runtime ledger
3. 命中 systemd cgroup / unit
4. 命中 restart lock + worker still progressing
5. 命中 explicit keepalive marker（未來可擴充）

## 6) Cleanup 決策規則（Decision Gate）

### 規則一：先找 root tree，再做決策

所有掃描命中都必須先提升到 **process tree root**，不能只殺葉子 MCP child。

原因：

- 避免只清 child，留下 parent 重生 child
- 避免破壞合法 active runtime 的部分元件

### 規則二：只清「整棵 stale tree」

`flush` 執行單位應為：

- stale interactive runtime root tree

而不是單獨 pid。

### 規則三：兩段式執行

1. `TERM`
2. 等待 grace period
3. 仍存活才 `KILL`

### 規則四：預設 dry-run 友善

應保留：

- `flush --dry-run`
- `status` 顯示 stale candidate count
- 每個 candidate 顯示 classification / reason tags

## 7) 需要新增的資料模型

### A. Runtime Classification Record

每個 candidate root 應輸出：

```text
type=runtime|mcp|interactive
root_pid=<pid>
class=protected-service|active-interactive|ephemeral|stale-interactive
reasons=<comma-separated>
tree_size=<n>
cmd=<root command>
```

### B. Active Runtime Ledger

需要把目前已存在的 active runtime 來源整合成單一集合：

- webctl PID files
- restart worker lock / tx ledger
- 未來 TUI active runtime ledger
- service runtime set

### C. TTL / Age Policy

建議初版：

- restart worker TTL：10 分鐘
- maintenance worker TTL：可配置，預設 30 分鐘
- stale interactive runtime 不以 age 單獨判死，但 age 可提升 confidence

## 8) `webctl.sh` 行為設計

### `status`

應顯示：

- active dev runtime
- production service runtime
- stale interactive runtime candidate count
- 提示 `./webctl.sh flush --dry-run`

若可行，進一步顯示：

- `protected=<n> active=<n> stale=<n>`

### `flush --dry-run`

輸出每個 root tree：

- root pid
- class
- reasons
- command

### `flush`

只清 `class=stale-interactive` 的 root trees。

### `restart`

dev path：

- build
- stop
- flush stale interactive trees
- start

production path：

- 維持 `web-refresh`
- **不直接借用 interactive stale cleanup 去碰 systemd service tree**

## 9) TUI 納入設計（必要但可分階段）

目前最大的缺口其實是：

> `webctl` 能保護 webctl 自己的 active runtime，但對「一般互動式 TUI / CLI 啟動的 opencode runtime」缺少 canonical active ledger。

因此完整方案最終要補：

### TUI Active Session Ledger

建議在 XDG runtime/state 下寫入：

- session id
- root pid
- ppid
- sid / pgid
- tty
- started_at
- heartbeat_at
- mode=tui|cli|webctl|maintenance

### 生命周期規則

- 啟動時註冊
- 正常退出時刪除
- heartbeat 更新
- `flush` 對超時且無 live pid 的 ledger 做回收

這樣才可真正判斷：

- 哪些 interactive `opencode` 是 active
- 哪些是 stale

## 10) 實作分期（Recommended Rollout）

### Phase 1（低風險，先做）

只擴充 `webctl` 現有 flush：

- 引入 classification record
- 將 orphan candidate 提升為 stale-interactive candidate
- 加入 reason tags
- 整棵 tree cleanup
- 不碰 TUI ledger

**效果**：

- 對 webctl / 明顯孤兒 / 明顯失聯 MCP tree 有更好清理能力

### Phase 2（完整互動式 runtime 管理）

新增 TUI/CLI active session ledger：

- `opencode` 啟動註冊
- heartbeat
- exit cleanup
- `webctl flush` / future `opencode doctor` 共用 ledger

**效果**：

- 可以把「獨立 opencode binary 還掛著」準確分類為 active 或 stale

### Phase 3（進階）

加入：

- `opencode doctor process`
- `opencode cleanup --stale-runtime`
- 更細的 cgroup / tty / session evidence

## 11) Stop Gates / 風險邊界

以下情況不得自動清理：

1. 命中 systemd service tree
2. 命中 active PID ledger
3. 命中 live restart worker
4. 無法確定 root tree 邊界
5. 僅因 command 字串模糊相似而命中

## 12) 驗證策略

### 靜態驗證

- `bash -n webctl.sh`

### 動態驗證（後續實作時）

1. 建立一個正常 webctl dev runtime
2. 建立一個刻意 orphan/stale 的 opencode 或 MCP tree
3. `flush --dry-run` 應只列 stale tree
4. `flush` 後 stale tree 消失，active runtime 保留
5. `restart` 期間不應誤殺新啟動 tree

## 13) 設計結論

本設計的核心不是「找誰啟動」，而是建立：

> **active / service / ephemeral / stale 四分法**

讓 `flush` 與 `restart` 都以 **stale interactive runtime** 為清理單位，並以 root tree + evidence tags 做精準判斷。

## 14) Architecture Sync

Architecture Sync: Updated

- 已同步 `docs/ARCHITECTURE.md`：`webctl.sh` stale interactive runtime cleanup 契約。

---

## 15) Phase 1 實作結果（2026-03-12）

- 已將 `webctl.sh flush` 從單純 orphan 掃描提升為 stale interactive runtime 掃描。
- 初版規則已接入：
  - 掃描 `opencode` / web runtime / internal MCP / common local MCP candidates
  - 提升到 root tree
  - 排除 active webctl tracked tree
  - 排除 production service main PID tree
  - 排除 `_restart-worker`
  - 排除仍有 live TTY 的 interactive root
  - 只對 `class=stale-interactive` 輸出 flush candidates
- 驗證結果：
  - ✅ `bash -n /home/pkcs12/projects/opencode/webctl.sh`
  - ✅ `bash /home/pkcs12/projects/opencode/webctl.sh status`
  - ✅ `bash /home/pkcs12/projects/opencode/webctl.sh flush --dry-run`
- 目前 dry-run 命中 3 個 stale interactive candidates：
  - `npm exec @modelcontextprotocol/server-memory`
  - `bun /home/pkcs12/projects/opencode/packages/mcp/refacting-merger/src/index.ts`
  - `bun /home/pkcs12/projects/opencode/packages/mcp/system-manager/src/index.ts`
