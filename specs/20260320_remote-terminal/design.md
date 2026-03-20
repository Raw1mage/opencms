# Design

## Context

opencode 目前的 tool execution 全部發生在本地 process 內。TaskTool 的 worker 透過 `Bun.spawn` 產生 child process，經 stdin/stdout JSON protocol 進行指令派發與結果回收。這個架構可以自然延伸到 SSH remote：SSH 本身就是 stdin/stdout pipe。

現有 multi-server 功能（webapp「新增伺服器」）是前端層級的 SDK baseUrl 切換，與 per-user daemon 無關，無法實現真正的分散式工作。

## Goals / Non-Goals

**Goals:**

- 最小化遠端部署成本（single binary, no runtime dependency）
- 複用現有 worker JSON protocol，避免發明新協定
- Tool dispatch 的 local/remote 切換對上層透明
- SSH tunnel 的生命週期自動管理

**Non-Goals:**

- 不做 agent-to-agent 的分散式協調（遠端只是 tool executor）
- 不做遠端 LLM inference
- 不做即時檔案同步或 shadow filesystem

## Decisions

### DD-1: 通訊協定複用 Worker JSON Protocol

現有 `SessionWorkerCommand` 已定義 `run`、`cancel`、`done`、`heartbeat` 等 JSON 指令格式。Remote agent 的協定應基於此擴展，增加 `exec`（shell）、`read`（file）、`write`（file）、`glob`（file search）等 tool-specific 指令。

理由：減少學習成本、與現有 supervisor/monitor 整合更容易。

### DD-2: SSH Tunnel 用 `ssh` Process，不用 libssh

直接 spawn 系統的 `ssh` binary，透過 `-o StrictHostKeyChecking=...` 等 flag 控制行為。Stdin/stdout 直接作為 JSON transport。

理由：
- 免除 native dependency（libssh2 binding）
- 自動繼承使用者的 `~/.ssh/config`、agent forwarding、proxy jump
- 與 bun/node 的 spawn API 完全相容

### DD-3: Remote Agent Binary 技術選型（待決策）

候選方案：

| 選項 | 優點 | 缺點 |
|------|------|------|
| **Go** | 靜態 binary、跨平台、無依賴 | 團隊需學 Go |
| **Bun compile** | 與現有 codebase 同語言 | binary 較大（~90MB）、需要 glibc |
| **Rust** | 最小 binary、效能最佳 | 開發成本最高 |
| **Shell script** | 零依賴、最小 | 複雜度有限、JSON parsing 困難 |

**決策：Go**。靜態 binary、零依賴、交叉編譯簡單，且 binary 大小 (~10-20MB) 適合 scp 佈建。

### DD-3b: Agent Scope — 漸進式擴展

Phase 1 僅實作最小核心（exec / read / write / glob / git / heartbeat），預留 plugin extension 機制。未來按需擴展 MCP proxy 等能力，遠端可選裝 plugin binary。

### DD-3c: SSH Tunnel 建立時機 — Lazy

首次 tool call 時才建立 SSH tunnel，省資源。Idle timeout 後自動關閉，下次 tool call 重新建立。不做 eager warmup。

### DD-4: Tool Dispatch 抽象化為 Backend Interface

```typescript
interface ToolBackend {
  exec(command: string, opts?: ExecOpts): Promise<ExecResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  glob(pattern: string, cwd?: string): Promise<string[]>
  gitOp(args: string[]): Promise<ExecResult>
  heartbeat(): Promise<boolean>
  dispose(): Promise<void>
}
```

LocalToolBackend = 現有邏輯（直接 spawn）
RemoteToolBackend = 透過 SSH tunnel 派發 JSON 指令

### DD-5: Remote Target 設定在 Project 層級

```typescript
// project config extension
remoteTarget?: {
  host: string           // SSH host (or alias from ~/.ssh/config)
  user?: string          // SSH user (default: current user)
  port?: number          // SSH port (default: 22)
  identityFile?: string  // SSH identity file path
  agentPath?: string     // remote agent binary path (default: ~/.opencode/bin/opencode-agent)
}
```

一個 project 綁定一個 remote target。Session 繼承 project 的設定。

## Data / State / Control Flow

```
[本地 opencode daemon]
    │
    ├─ LLM API call → Provider → Claude/Gemini/...
    │
    ├─ Tool dispatch decision
    │   ├─ remoteTarget configured? → RemoteToolBackend
    │   └─ no remote → LocalToolBackend (現有路徑)
    │
    └─ RemoteToolBackend
        │
        ├─ SSH tunnel (ssh user@host -o ... < stdin > stdout)
        │   └─ JSON over stdio
        │
        └─ Remote Agent (on target host)
            ├─ exec: shell command → result
            ├─ read: file path → content
            ├─ write: file path + content → ok
            ├─ glob: pattern → file list
            ├─ git: args → result
            └─ heartbeat → pong
```

## Risks / Trade-offs

- **延遲**：SSH round-trip 會增加每個 tool call 的延遲。LAN 環境影響小（<10ms），WAN 可能明顯。→ 緩解：批次操作、pipeline（多個指令一次送出）
- **斷線處理**：SSH tunnel 斷線時 in-flight tool call 會遺失。→ 緩解：heartbeat 偵測 + tool call timeout + graceful error 回報
- **安全性**：remote agent 有完整的 shell 和 file system 權限。→ 緩解：使用者自己管理 SSH key 權限，remote agent 不暴露 network port
- **Binary 大小**：Bun compile 產出約 90MB，Go 約 10-20MB，可能影響初次佈建速度。→ 緩解：壓縮傳輸、lazy 佈建
- **相容性**：遠端 OS / arch 需要對應的 binary。→ 緩解：提供 linux-amd64、linux-arm64、darwin-arm64 三個 target

## Critical Files

- `packages/opencode/src/tool/task.ts` — tool dispatch 入口
- `packages/opencode/src/cli/cmd/session.ts` — worker protocol 定義
- `packages/opencode/src/process/supervisor.ts` — process lifecycle
- `packages/opencode/src/session/index.ts` — session config schema
- `packages/opencode/src/project/index.ts` — project config schema
