# Design

## Context

現行架構下 opencode backend daemon 用 `sudo -n opencode-run-as-user` 對每一句 shell/PTY 命令做身份切換。Daemon 持有全域 sudo 權限，攻擊面過大（daemon 被攻陷 = 可以任意使用者身份執行命令）。

TUI 透過 Worker thread 自帶 embedded Server.App()，與 webapp backend 完全隔離。Bus event 系統有缺陷（account 事件未上 bus、payload 不完整、SSE 無 catch-up）。Backend 有效能瓶頸（SDK cache leak、無連線數限制）。

Bun runtime 不原生支援 fd passing（SCM_RIGHTS）或接手既有 TCP fd。

## Goals / Non-Goals

**Goals:**

- 消除 sudo-n 全域特權風險（per-user daemon 取代 per-command sudo）
- TUI 和 webapp 共享同一個 per-user daemon
- Account 事件上 bus，多 client 即時同步
- SSE 斷線重連 catch-up
- Bus event payload 完整化
- 修復效能瓶頸

**Non-Goals:**

- 不 fork Bun runtime
- 不改變 webapp 前端 UI（React 組件、頁面佈局、樣式）
- 不改變 TUI 前端 UI（Ink/React 渲染層、使用者操作流程）
- 不處理 PTY session lifecycle
- 不處理跨機器 TUI attach
- 不移除 parseProvider()

## Decisions

### DD-1: 架構模型 — C root daemon + per-user opencode daemon

```
C Root Daemon (:1080)                    Per-user Opencode Daemon (uid=alice)
┌──────────────────────┐                 ┌──────────────────────────────┐
│ • listen TCP :1080   │   splice()      │ • Bun.serve({ unix: path })  │
│ • serve login.html   │ ─kernel-level─→ │ • 完整 opencode backend      │
│ • PAM auth           │   零拷貝轉發    │ • HTTP API / SSE / WebSocket │
│ • spawn per-user     │                 │ • Account / Session / Bus    │
│   (fork+setuid)      │                 │ • 以 alice 身份執行          │
│ ~800 行 C code       │                 └──────────────────────────────┘
└──────────────────────┘                         ▲
                                                 │ Unix socket 直連
                                          ┌──────┴──────┐
                                          │ TUI (alice)  │
                                          └─────────────┘
```

理由：
- Root daemon 只做 auth + connection broker，攻擊面最小化
- Per-user daemon 以目標使用者身份運行，不需要 sudo
- Daemon 被攻陷只影響該使用者（不是全系統）
- C 語言寫 root daemon：可使用 PAM C API、splice()、fork()+setuid()
- 對 opencode codebase 零侵入（只需加 --unix-socket 選項）

### DD-2: Connection Routing — splice() kernel-level proxy

Auth 成功後，C root daemon 用 splice() 系統呼叫在 client TCP fd 和 per-user daemon Unix socket 之間做 kernel-level 零拷貝轉發。

```c
// 簡化的 splice proxy loop
splice(client_fd, NULL, pipe_wr, NULL, PIPE_SIZE, SPLICE_F_NONBLOCK);
splice(pipe_rd, NULL, daemon_fd, NULL, PIPE_SIZE, SPLICE_F_NONBLOCK);
// 反方向同理
```

理由：
- Bun.serve() 不支援接手既有 TCP fd → 純 fd passing 不可行
- splice() 資料不經 userspace → 效能等同 fd passing（< 5µs/request）
- HTTP / SSE / WebSocket 三種協定均為 byte stream → splice 不需解析
- Root daemon 用 epoll 管理所有 splice 對 → O(1) per-event
- 未來若 Bun 支援 `handleConnection(fd)`，可無縫切換為 fd passing

Benchmark 預估（localhost Unix socket）：

| 方案 | 延遲 overhead | 記憶體 overhead |
|------|-------------|----------------|
| splice() proxy | < 5µs | 1 pipe pair per connection |
| Application proxy | 10-50µs | 1 buffer per connection |
| Native fd passing | ~1µs | 0 |

### DD-3: Per-user Daemon Spawn — fork() + setuid() + exec()

C root daemon 透過 fork() + setuid(target_uid) + exec("opencode serve --unix-socket ...") spawn per-user daemon。

```c
pid_t pid = fork();
if (pid == 0) {
    // Child process
    setgid(target_gid);
    setuid(target_uid);
    // Drop ALL privileges
    execvp("opencode", ["serve", "--unix-socket", socket_path, ...]);
}
```

理由：
- 一次性 privilege drop（setuid 後永遠是目標使用者）
- 比 sudo-n per-command 模型安全得多
- Per-user daemon process 可套用 cgroup / ulimit
- fork+setuid 是標準 Unix daemon 模式（sshd 同模型）

### DD-4: Discovery 機制 — XDG_RUNTIME_DIR file

Per-user daemon 啟動時寫入 `$XDG_RUNTIME_DIR/opencode/daemon.json`：

```json
{
  "socketPath": "/run/user/1000/opencode/daemon.sock",
  "pid": 12345,
  "startedAt": "2026-03-19T10:00:00Z",
  "version": "0.1.0"
}
```

TUI discoverDaemon()：讀取 file → 檢查 PID 存活（kill -0）→ 回傳 socket path 或 null。

理由：
- `$XDG_RUNTIME_DIR`（`/run/user/$UID`）是 per-user、tmpfs-backed
- 機器重啟自動清除
- TUI 只需讀 file，不需 probe socket

### DD-5: TUI 雙模式 — 獨立模式（預設）+ Attach 模式（明確選擇）

TUI 保留兩種明確的啟動模式，不做隱式 fallback：

```
# 獨立模式（向下相容）— Worker thread + embedded server
bun run dev
opencode

# Attach 模式（新）— 連到已在跑的 per-user daemon
bun run dev --attach
opencode --attach
```

Attach 模式下若找不到 per-user daemon → fail fast 報錯。
獨立模式維持現有行為不變。
兩者之間不做自動切換（不 fallback）。

理由：
- 天條：禁止新增 fallback mechanism（兩個模式是明確選擇，不是 fallback）
- 開發者日常用獨立模式，不需 daemon 即可工作
- Full stack 場景用 attach 模式，確保 TUI/webapp 共享 state
- Worker thread 保留，不破壞現有開發流程

### DD-6: Account Bus Events — 3 types + sanitized payload

```typescript
const AccountAdded = BusEvent.define("account.added", {
  providerKey: z.string(),
  accountId: z.string(),
  info: AccountInfoSanitizedSchema, // 無 apiKey
})
const AccountRemoved = BusEvent.define("account.removed", {
  providerKey: z.string(),
  accountId: z.string(),
})
const AccountActivated = BusEvent.define("account.activated", {
  providerKey: z.string(),
  accountId: z.string(),
  previousAccountId: z.string().optional(),
})
```

Publish 在 AccountManager service layer（不在底層 Account/Auth module）。

### DD-7: SSE Event ID — Global counter + ring buffer (1000)

每個 SSE event 附帶 monotonic ID。Server 維護 ring buffer（1000 條）。Client reconnect 攜帶 Last-Event-ID，server 補發遺漏。Buffer 不足 → sync.required event → client full refresh。

### DD-8: SDK Cache — LRU eviction

```typescript
// 新增 eviction
const MAX_SDK_CACHE_SIZE = 50
if (s.sdk.size > MAX_SDK_CACHE_SIZE) {
  // Evict oldest entry (by insertion order — Map preserves order)
  const oldest = s.sdk.keys().next().value
  s.sdk.delete(oldest)
}
```

理由：現有 Map 無 eviction，long-running daemon memory leak。

### DD-9: SSE Broadcast — Fire-and-forget + queue

現有 Bus.publish() 同步等待所有 subscriber。改為：
- SSE subscriber 使用獨立 queue（per-connection）
- publish() fire-and-forget（不等待 subscriber 處理完）
- Queue overflow → drop oldest event + 發送 sync.required

### DD-10: webctl.sh — Production/Dev 雙模式保留

```bash
# dev-start: 開發模式
dev-start() {
  compile_gateway_if_needed   # 編譯 C root daemon（若需要）
  start_gateway "dev"         # 啟動 root daemon（dev 模式 flag）
  start_frontend "dev"        # 啟動 frontend dev server
}

# systemd-install: 安裝 production unit files
systemd-install() {
  install_gateway_unit        # opencode-gateway.service（system-level）
  install_user_template_unit  # opencode-user@.service（user template）
}
```

## Data / State / Control Flow

### Connection Lifecycle（Webapp）

```
Browser → TCP connect :1080 → C root daemon accept()
  → GET / → serve login.html
  → POST /auth/login { user, pass }
  → PAM authenticate
  → Check per-user daemon alive?
    → No: fork() + setuid(user) + exec("opencode serve --unix-socket ...")
    → Yes: reuse existing
  → Connect to per-user daemon Unix socket
  → splice() setup: client_fd ↔ daemon_sock_fd
  → 302 redirect to / (now proxied to per-user daemon)
  → Per-user daemon serves full webapp
```

### Connection Lifecycle（TUI）

```
TUI process（same UID as per-user daemon）
  → readFile($XDG_RUNTIME_DIR/opencode/daemon.json)
  → verify PID alive
  → connect(socketPath) — Unix socket 直連
  → HTTP API + SSE event stream
  → Ink/React render
```

### Account Event Flow

```
User action → HTTP POST /api/v2/account/...
  → AccountManager.connectApiKey()
  → Account mutation + save()
  → Bus.publish("account.added", { providerKey, accountId, info })
  → SSE broadcast (with event ID)
  → All connected clients receive event
  → Each client updates local state from payload (no follow-up API call)
```

### SSE Catch-up Flow

```
Client SSE 斷線
  → Client 記錄 lastEventId = 150
  → ... server produces events 151~165 (stored in ring buffer) ...
  → Client reconnect, header: Last-Event-ID: 150
  → Server finds 151~165 in buffer
  → Server sends 151~165 in order
  → Server switches to live push
```

## Risks / Trade-offs

- **C daemon 維護成本** → 新增一個 C binary 需要獨立的 build chain 和 testing。但 daemon 功能極為聚焦（PAM + splice + process mgmt），不會膨脹
- **splice() 對 WebSocket** → splice 不解析 protocol，只做 byte forwarding。WebSocket upgrade 在 splice 建立後透傳應該可行，但需要驗證（SG-2）
- **Per-user daemon memory** → 每個使用者一個完整 opencode process。但 opencode 啟動後 idle memory 約 50-100MB，對 server 可接受
- **Multiple per-user daemons** → 10 個使用者 = 10 個 process × 50-100MB = 500MB-1GB。需要監控和 idle timeout
- **Auth state 管理** → C daemon 需在 splice 建立前完成 auth。HTTP 是 stateless，每個新 TCP 連線都需要 auth 嗎？→ 用 JWT cookie，C daemon 驗證 cookie 後直接 splice
- **TUI 找不到 daemon 的 UX** → 使用者必須先啟動 backend（webctl.sh dev-start）。這改變了現有 TUI 的「直接執行」體驗
- **Event payload 大小** → Full Account.Info 需 sanitize apiKey。Full Session.Info 可能較大，需監控 SSE bandwidth
- **SDK cache eviction** → LRU 可能 evict 仍在使用的 provider。需要 reference counting 或 access-time based eviction

## Critical Files

### 新增
- `daemon/opencode-gateway.c`
- `daemon/Makefile`
- `daemon/login.html`
- `daemon/opencode-gateway.service`
- `daemon/opencode-user@.service`

### 修改
- `packages/opencode/src/cli/cmd/serve.ts`
- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/cli/cmd/tui/thread.ts`
- `packages/opencode/src/cli/cmd/tui/attach.ts`
- `packages/opencode/src/bus/index.ts`
- `packages/opencode/src/server/routes/global.ts`
- `packages/opencode/src/account/manager.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/app/src/context/global-sdk.tsx`
- `webctl.sh`

### 移除
- `scripts/opencode-run-as-user.sh`
- `packages/opencode/src/system/linux-user-exec.ts`
