# Spec: Daemonization V2 — Unified Per-User Process Model

## 1. Process Model

### 1.1 Single Daemon Invariant

每個 Linux user 在同一時間最多有一個 opencode daemon process。

- **Registry**: `$XDG_RUNTIME_DIR/opencode/daemon.json`
- **Lock**: `$XDG_RUNTIME_DIR/opencode/daemon.pid` (single-instance guard)
- **Socket**: `$XDG_RUNTIME_DIR/opencode/daemon.sock`

### 1.2 Spawn Sources（兩種啟動途徑）

| Source | Trigger | Mechanism |
|--------|---------|-----------|
| **TUI** | `bun run dev` / `opencode` | `Daemon.spawn()` → detached `opencode serve --unix-socket` |
| **Gateway** | Web login (PAM auth) | `fork() → setuid() → execvp()` → `opencode serve --unix-socket` |

兩者都寫入相同的 `daemon.json`，遵守相同的 `daemon.pid` single-instance guard。

### 1.3 Adopt Protocol

後到者（TUI 或 gateway）在 spawn 之前必須先嘗試 adopt：

```
readDiscovery() → daemon.json exists?
  ├─ Yes → isPidAlive(pid)?
  │   ├─ Yes → socket connectable?
  │   │   ├─ Yes → ADOPT (return existing info)
  │   │   └─ No  → STALE (cleanup + spawn new)
  │   └─ No  → STALE (cleanup + spawn new)
  └─ No  → SPAWN NEW
```

Gateway 已有 `try_adopt_from_discovery()` 實作此邏輯。TUI 的 `Daemon.spawn()` 需在 spawn 前加入相同的 adopt-first 檢查。

### 1.4 Access Modes（兩種存取方式）

| Mode | Transport | Consumer |
|------|-----------|----------|
| **TUI attach** | Unix socket (fetch + SSE) | TUI thin client |
| **Web proxy** | Gateway splice (TCP ↔ pipe ↔ Unix socket) | Browser via gateway |

兩者共享同一個 daemon process，因此 accounts、sessions、SSE events 天然同步。

## 2. Worker Mode Elimination

### 2.1 Current Worker Mode（待移除）

```
thread.ts (TUI main) → new Worker(worker.ts)
  ├─ worker.ts: in-process server, RPC listener
  ├─ thread.ts: createWorkerFetch() → RPC → worker.ts → Server.App().fetch()
  └─ thread.ts: createEventSource() → RPC → worker.ts → Rpc.emit("event")
```

### 2.2 Target: Always-Attach

```
thread.ts (TUI main) → Daemon.spawnOrAdopt()
  ├─ daemon: standalone process, Unix socket server
  ├─ thread.ts: createUnixFetch(socketPath)
  └─ thread.ts: createUnixEventSource(socketPath, baseUrl)
```

### 2.3 Migration Path

1. `thread.ts` handler 的非 `--attach` 路徑改為與 `--attach` 相同邏輯
2. `--attach` flag 保留但變為 no-op（預設就是 attach）
3. Worker thread 相關程式碼（`worker.ts`, `createWorkerFetch`, `createEventSource` via RPC）移至 deprecated 或直接移除
4. `OPENCODE_CLI_TOKEN` 機制改為 daemon-level auth（或信任 Unix socket peer credential）

### 2.4 開發模式考量

開發時 `bun run dev` 需要能快速啟動。Always-attach 的啟動延遲必須 < 3s：

- `Daemon.spawn()` 已有 150ms poll interval + 10s timeout
- 優化：daemon 啟動時優先寫 discovery file，延後非關鍵初始化
- `OPENCODE_SKIP_TUI=1` 已確保 daemon 不載入 TUI modules

## 3. Gateway Integration

### 3.1 Adopt-First Flow

```
Gateway login success
  → resolve_runtime_dir(uid)
  → read daemon.json
  → PID alive + socket connectable?
    ├─ Yes → adopt into registry → splice proxy
    └─ No  → fork+setuid+exec → poll daemon.json → splice proxy
```

此流程已在 V1 `try_adopt_from_discovery()` 中實作。V2 需確保：

- adopt 時驗證 socket 確實可連接（不只是 PID alive）
- adopt 後 registry entry 的 state 與 spawn 後一致
- 被 adopt 的 daemon 若 crash，gateway SIGCHLD 不會收到（因為不是 gateway 的 child）→ 需要替代的 liveness check

### 3.2 Non-Child Daemon Liveness

Gateway spawn 的 daemon 是 child process，crash 時 SIGCHLD 會觸發 cleanup。但 TUI spawn 的 daemon 不是 gateway child，需要替代機制：

**Option A**: Gateway 定期 poll daemon socket connectivity（heartbeat）
**Option B**: Gateway 在每次 splice request 時 lazy-check（連不上就 re-spawn）
**Option C**: daemon.json 加入 heartbeat timestamp，daemon 定期更新

建議 **Option B**（lazy-check），因為：
- 最簡單
- splice 失敗時 gateway 本來就要處理
- 不增加額外 polling overhead

### 3.3 systemd HTTP Daemon 處置

`opencode-user-daemon@.service` 目前在 port 42000 運行，繞過 gateway。V2 策略：

- **移除獨立 HTTP daemon**：不再需要 systemd per-user service 跑 TCP mode
- **保留 systemd 可選性**：systemd 可以用來確保 daemon 在 boot 時啟動，但改為 Unix socket mode
- 或：完全移除 systemd per-user service，由 gateway 或 TUI 按需 spawn

## 4. Discovery Protocol Enhancement

### 4.1 daemon.json 擴充

```typescript
type DaemonInfo = {
  socketPath: string
  pid: number
  startedAt: number
  version: string
  // V2 additions:
  spawnedBy: "tui" | "gateway"  // 誰 spawn 了這個 daemon
  directory?: string             // daemon 的 working directory（若有）
  features?: string[]            // 支援的功能旗標
}
```

### 4.2 Stale Detection

現有 `readDiscovery()` 已做 `isPidAlive()` 檢查。V2 增加 socket connectivity probe：

```typescript
async function readDiscovery(): Promise<Info | null> {
  // ... existing file read + PID check ...
  // V2: also verify socket is connectable
  if (!await isSocketConnectable(info.socketPath)) {
    await removeDiscovery().catch(() => {})
    return null
  }
  return info
}
```

## 5. TUI Lifecycle Changes

### 5.1 Startup Flow

```
bun run dev [project]
  → Daemon.spawnOrAdopt()
    → readDiscovery()
      → found + alive + connectable → return existing
      → not found → spawn() → poll → return new
  → createUnixFetch(socketPath)
  → createUnixEventSource(socketPath, baseUrl)
  → tui({ url, fetch, events, ... })
```

### 5.2 Shutdown Flow

TUI 退出時：
- **不** kill daemon（daemon 是 long-lived process）
- 只 abort SSE connection
- daemon 持續服務 web 和未來的 TUI re-attach

### 5.3 Directory Context

Worker mode 中，directory 由 `process.cwd()` 決定（Worker 繼承 TUI 的 cwd）。
Always-attach mode 中，daemon 的 cwd 可能與 TUI 啟動時不同。

解法：TUI 在 API request 中帶 `x-opencode-directory` header（SDK 已支援 `directory` 參數）。
daemon 端 `app.ts` 已有 `Instance.provide({ directory })` 機制。

### 5.4 Auth Context

TUI 本身就是使用者直接發起的（TTY interactive），不需要登入驗證。

- Worker mode 使用 `OPENCODE_CLI_TOKEN` 是因為 Worker thread 透過 RPC 呼叫 server，需要辨識身份
- Always-attach mode 透過 Unix socket 連接，daemon 和 TUI 是同一個 user — **不需要額外 auth**
- 這與 V1 attach mode 一致：`createUnixFetch()` 不帶任何 auth header

結論：移除 Worker mode 後，`OPENCODE_CLI_TOKEN` 在 TUI context 不再需要。Gateway 的 JWT/PAM auth 只服務 web 端。

## 6. Bun Flags Preservation

### 6.1 問題

`Daemon.spawn()` 目前只傳 `Bun.argv.slice(1, 2)`（entry file），不傳 bun flags 如 `--conditions=browser`。

### 6.2 解法

spawn 時需保留必要的 bun flags：

```typescript
const bunFlags = Bun.argv
  .slice(1)
  .filter(arg => arg.startsWith("--conditions=") || arg.startsWith("--preload="))

const spawnArgs = isBunRuntime
  ? [Bun.argv[0], ...bunFlags, entryFile, ...args]
  : [bin, ...args]
```

## 7. Known Issue: Attach Mode Empty State

`bun run dev --attach` 連接到 daemon 後，TUI 顯示空的 accounts/sessions。API 驗證結果正常（直接 curl daemon socket 可取得 21 providers、12 accounts、5 sessions），但 TUI 端未能正確 hydrate。

可能原因（待 V2 實作時 debug）：
- attach mode 的 `createUnixEventSource()` SSE 連接是否正確接收 bootstrap events
- TUI SDK client 在 attach mode 是否帶了正確的 `directory` header（Worker mode 不帶 directory，但 daemon 可能需要）
- daemon 端 `Instance.provide()` 在沒有 `x-opencode-directory` header 時的 fallback 行為
- attach mode 連接的 daemon 是否已完成 bootstrap（若 daemon 剛啟動，可能 state 尚未載入）

V2 的 always-attach 設計需要確保這個問題被根治，而不只是從 Worker mode 繞過。

## 8. Backwards Compatibility

- `--attach` flag 保留，變為 no-op（或 deprecated warning）
- `bun run dev` 行為改變：從 Worker mode 變為 always-attach
- Gateway 無需改動（adopt-first 已實作）
- Web frontend 無需改動（透過 gateway 或直連 daemon，transport 不變）
