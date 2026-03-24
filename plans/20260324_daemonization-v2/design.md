# Design: Daemonization V2 — Unified Per-User Process Model

## 1. Process Lifecycle State Machine

```
                    ┌──────────────────────────────────────────────┐
                    │              PER-USER DAEMON                  │
                    │                                              │
  TUI spawn ───┐   │  SPAWNING → READY → SERVING ──→ SHUTDOWN     │
               ├──→│     │         │        │            │         │
  GW  spawn ───┘   │     ↓         ↓        ↓            ↓         │
                    │  daemon.pid  daemon.json  (serving)  cleanup  │
                    │             daemon.sock                       │
                    └──────────────────────────────────────────────┘
                              ↑                    │
                    ┌─────────┘                    │
                    │  ADOPT (not spawn)           │
  TUI adopt ────────┤                              │
  GW  adopt ────────┘                              │
                                                   │
                    ┌──────────────────────────────┘
                    ↓
               STALE DETECTION
               (PID dead / socket unreachable)
                    │
                    ↓
               CLEANUP → re-enter SPAWNING
```

### State Transitions

| From | To | Trigger | Actions |
|------|----|---------|---------|
| (none) | SPAWNING | TUI `bun run dev` / GW login, no existing daemon | `Daemon.spawn()` or `fork+exec` |
| SPAWNING | READY | daemon.json written, socket listening | Discovery file available |
| READY | SERVING | First client connects (TUI attach / GW splice) | — |
| SERVING | SERVING | Additional clients connect/disconnect | — |
| SERVING | SHUTDOWN | SIGTERM / SIGINT / all-clients-idle-timeout | cleanup files |
| (any) | STALE | PID dead or socket unreachable | `removeDiscovery()` |

## 2. Spawn-or-Adopt Decision Flow

```
Client (TUI or Gateway) wants to connect to daemon
  │
  ├─ readDiscovery()
  │   ├─ daemon.json missing ──────────────────→ SPAWN NEW
  │   ├─ daemon.json found
  │   │   ├─ isPidAlive(pid) = false ──────────→ CLEANUP + SPAWN NEW
  │   │   ├─ isPidAlive(pid) = true
  │   │   │   ├─ socket connectable = false ──→ CLEANUP + SPAWN NEW
  │   │   │   └─ socket connectable = true ──→ ADOPT (return info)
  │   │   └─ parse error ─────────────────────→ CLEANUP + SPAWN NEW
  │   └─ (error reading file) ────────────────→ SPAWN NEW
  │
  └─ spawnOrAdopt() returns DaemonInfo
```

### Race Safety

兩個 client 同時嘗試 spawn 時的處理：

1. `daemon.pid` 是 single-instance guard（`checkSingleInstance()`）
2. 先到者創建 `daemon.pid` → 後到者讀到 PID → adopt
3. 窗口極小：兩者同時發現「沒有 daemon」→ 同時 spawn → 先啟動者寫 `daemon.pid` → 後啟動者的 `checkSingleInstance()` 偵測到 → 後啟動者自行 exit
4. 後到的 client poll `readDiscovery()` → 最終會讀到先到者的 daemon

## 3. Thread.ts Refactoring

### 3.1 Current Code Structure（待重構）

```
TuiThreadCommand.handler
  ├─ if (args.attach)         → attach mode (Unix socket)
  └─ else                     → Worker mode (in-process)
      ├─ new Worker(worker.ts)
      ├─ createWorkerFetch(client)
      ├─ createEventSource(client)
      └─ tui({ url, fetch, events })
```

### 3.2 Target Code Structure

```
TuiThreadCommand.handler
  └─ (always) → spawnOrAdopt + attach mode
      ├─ Daemon.spawnOrAdopt()
      ├─ createUnixFetch(socketPath)
      ├─ createUnixEventSource(socketPath, baseUrl)
      └─ tui({ url, fetch, events, directory })
```

### 3.3 Removed Components

| Component | Reason |
|-----------|--------|
| `worker.ts` | No longer needed; daemon is a separate process |
| `createWorkerFetch()` | Replaced by `createUnixFetch()` |
| `createEventSource()` (RPC-based) | Replaced by `createUnixEventSource()` |
| Worker thread signal handling | Daemon handles its own signals |
| `OPENCODE_CLI_TOKEN` in TUI | Unix socket peer trust |

### 3.4 Preserved Components

| Component | Reason |
|-----------|--------|
| `createUnixFetch()` | Already used in attach mode |
| `createUnixEventSource()` | Already used in attach mode |
| `tui()` | TUI rendering unchanged |
| Terminal reset logic | Still needed for TUI cleanup |
| `--project` directory resolution | Passed as SDK `directory` parameter |

## 4. Daemon.ts Enhancement

### 4.1 New: `spawnOrAdopt()`

```typescript
export async function spawnOrAdopt(opts?: {
  timeoutMs?: number
  directory?: string
}): Promise<Info> {
  // Step 1: Try adopt
  const existing = await readDiscovery()
  if (existing && await isSocketConnectable(existing.socketPath)) {
    return existing
  }

  // Step 2: Cleanup stale if needed
  if (existing) {
    await removeDiscovery().catch(() => {})
  }

  // Step 3: Spawn new
  return spawn(opts)
}
```

### 4.2 New: `isSocketConnectable()`

```typescript
async function isSocketConnectable(socketPath: string): Promise<boolean> {
  try {
    const res = await fetch("http://daemon/v2/global/health", {
      unix: socketPath,
      signal: AbortSignal.timeout(2000),
    } as any)
    return res.ok
  } catch {
    return false
  }
}
```

### 4.3 Enhanced: `spawn()`

保留 bun flags：

```typescript
// Preserve critical bun flags
const bunFlags: string[] = []
for (const arg of Bun.argv.slice(1)) {
  if (arg.startsWith("--conditions=")) bunFlags.push(arg)
  if (arg === entryFile) break  // stop at entry file
}

const spawnArgs = isBunRuntime
  ? [Bun.argv[0], ...bunFlags, entryFile, ...args]
  : [bin, ...args]
```

## 5. Gateway Liveness for Adopted Daemons

### Problem

Gateway 用 `SIGCHLD` 偵測 child daemon crash。但 TUI spawn 的 daemon 不是 gateway child，gateway 收不到 SIGCHLD。

### Solution: Lazy Liveness Check

```c
// In gateway splice proxy, when splice fails:
if (splice_failed && errno == EPIPE) {
    // Daemon may have crashed — check liveness
    if (!daemon_is_alive(d)) {
        cleanup_daemon_entry(d);
        // Next request will trigger re-spawn
    }
}
```

Gateway 不需要主動 poll。splice 失敗時才 lazy-check：
- 連不上 → 清理 registry entry → 下次 request 重新 spawn
- 仍然活著 → 是暫時性連接問題 → retry

## 6. Directory Context Propagation

### Problem

Worker mode 中 daemon 和 TUI 共享 cwd。Always-attach mode 中 daemon 可能在不同 cwd。

### Solution

TUI 啟動時解析 directory，透過 SDK `directory` parameter 傳給 daemon：

```typescript
// thread.ts
const directory = args.project
  ? path.resolve(baseCwd, args.project)
  : process.cwd()

await tui({
  url,
  fetch: customFetch,
  events,
  directory,  // ← new: pass to SDK
  args: { ... },
})
```

SDK 已支援 `x-opencode-directory` header（`packages/sdk/js/src/client.ts`）。
Server `app.ts` 已支援 `Instance.provide({ directory })`。

## 7. webctl.sh Process Management

### 7.1 Unified Status

```bash
do_status() {
  # Gateway status
  # Per-user daemons (from daemon.json files in /run/user/*/opencode/)
  # No more separate "HTTP daemon" / "Worker" categories
}
```

### 7.2 Unified Stop

```bash
do_stop() {
  # Stop gateway → all splice connections drop
  # Signal all per-user daemons (from daemon.json) → SIGTERM
  # Cleanup stale discovery files
}
```

## 8. Migration Strategy

### Phase 1: Add `spawnOrAdopt()` + socket probe
- 純 additive，不改變現有行為
- 新增 `Daemon.spawnOrAdopt()` 和 `isSocketConnectable()`

### Phase 2: TUI always-attach
- `thread.ts` 的非-attach 路徑改為使用 `spawnOrAdopt()` + attach
- `--attach` flag 變為 no-op
- Worker thread code 保留但不再被呼叫

### Phase 3: Cleanup
- 移除 `worker.ts`、`createWorkerFetch()`、RPC-based `createEventSource()`
- 移除 `OPENCODE_CLI_TOKEN` 生成（`index.ts` line 94-96）
- 更新 `index.ts` 中的 TUI module import 邏輯

### Phase 4: Gateway hardening
- Gateway adopt-first 已有基礎，確認 lazy liveness check
- 移除 systemd HTTP daemon service（或改為 Unix socket mode）

### Phase 5: Integration validation
- 完整的 TUI ↔ Web 互通測試
- Process lifecycle 測試（spawn, adopt, crash recovery, cleanup）
