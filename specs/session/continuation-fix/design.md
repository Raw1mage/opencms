# Design

## Context

- OpenCode daemon 在重啟後可接續舊 session 繼續對話，但系統不做任何版本相容性檢查
- Session state（execution identity, tool call history, ToolPart status）跨 daemon 版本存活，但 runtime state（tool schemas, worker processes, account tokens）在重啟時重建
- 這個 gap 導致：LLM 模仿舊格式 tool calls、orphan subagent tasks、stale account references
- Worker 子進程的 bootstrap 失敗無法診斷，因為 Log 依賴 Bus，Bus 在 bootstrap 完成後才初始化

## Goals / Non-Goals

**Goals:**

- 在不破壞現有 session 格式的前提下，增加 restart resilience
- 最小侵入：只在關鍵接口處加 guard/normalization/recovery，不重構架構
- 每個 phase 獨立可交付，不相互依賴

**Non-Goals:**

- 不建立 tool schema 版本化系統
- 不做 session format migration framework
- 不重構 worker 進程架構

## Decisions

- DD-1: Orphan recovery 在 InstanceBootstrap 完成後以 async background task 執行，不阻塞 daemon 啟動。理由：避免啟動延遲影響所有 session，orphan recovery 不需要即時完成
- DD-2: Version guard 只做 warn + metadata flag，不 block session 載入。理由：breaking session load 的風險太高，先 observe 再決定是否需要 hard gate
- DD-3: Tool input normalization 使用 registry-driven mapping（從當前 tool schema 推導 canonical param name），不 hardcode 特定 tool 的 migration。理由：apply_patch 只是第一個踩到的，未來任何 tool 改 schema 都會有同樣問題
- DD-4: Worker pre-bootstrap log 使用 `fs.appendFileSync` 直寫 `{dataDir}/log/worker-{pid}.log`，不走 Bus。理由：Bus 在 bootstrap 前是 no-op，直寫是唯一能保證觀測性的方式
- DD-5: Execution identity validation 在 processor.ts 的 account resolution path 中做，fallback 到同 provider 的 active account。理由：這是最接近 API call 的地方，可以在 401 之前攔截

## Data / State / Control Flow

### Orphan Recovery Flow

```
Daemon start
  → InstanceBootstrap()
  → bootstrap complete
  → async: scanOrphanTasks()
    → query all sessions with ToolPart status="running" AND tool="task"
    → for each: check if worker process exists → NO → mark status="error"
    → publish Bus event for each recovered orphan
    → parent session UI auto-updates via Bus subscription
```

### Tool Input Normalization Flow

```
SessionPrompt.loop() / LLM.stream()
  → assemble message context
  → for each ToolPart in history:
    → lookup current tool schema from registry
    → compare ToolPart.input keys against schema.properties
    → if mismatch: create normalized copy with remapped keys
    → feed normalized copy to LLM (original storage untouched)
```

### Version Guard Flow

```
Session.get(sessionID)
  → read Session.Info from storage
  → compare info.version vs Installation.VERSION
  → if different: set info._staleVersion = true, log warning
  → return info (caller can check _staleVersion)
```

## Risks / Trade-offs

- Risk: Orphan recovery marking an actually-running task as error (race condition if daemon restarts and a task finishes at the same moment) → Mitigation: orphan scan runs 5 seconds after bootstrap, giving in-flight workers time to send their Done event. Also check process liveness via `ProcessSupervisor` before marking.
- Risk: Tool input normalization incorrectly remaps a parameter that has the same type but different semantics → Mitigation: only remap when the canonical param is missing AND the provided param is not in the current schema. Conservative: if ambiguous, don't remap.
- Risk: Pre-bootstrap file logging creates log file accumulation → Mitigation: rotate/cleanup on successful bootstrap; keep only last N failed worker logs.
- Trade-off: Version guard is warn-only, not a hard block → Accepts the risk that truly incompatible sessions may produce runtime errors, in exchange for not breaking session resumption.

## Critical Files

- `packages/opencode/src/session/index.ts` — Session.get, Session.Info schema
- `packages/opencode/src/session/processor.ts` — account resolution, execution identity
- `packages/opencode/src/session/prompt.ts` — message context assembly
- `packages/opencode/src/session/llm.ts` — normalizeMessages, tool call handling
- `packages/opencode/src/session/message-v2.ts` — ToolPart, ToolState schema
- `packages/opencode/src/tool/task.ts` — worker lifecycle, orphan detection
- `packages/opencode/src/tool/registry.ts` — tool schema for normalization lookup
- `packages/opencode/src/cli/cmd/session.ts` — worker process bootstrap sequence
- `packages/opencode/src/project/bootstrap.ts` — init sequence, orphan scan trigger
- `packages/opencode/src/bus/sink.ts` — emitDebug no-op handler
