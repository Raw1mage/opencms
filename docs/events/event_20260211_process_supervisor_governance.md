# Event: Process Supervisor 全面治理方案

Date: 2026-02-11
Status: Completed (Phase 1)  
Severity: Critical

## 1. Orphan Process RCA (根本原因分析)

### 1.1 症狀 (Symptoms)

- 發現 5 個高負載 Bun Orphan Process (CPU 70%-155%)
- 執行時間長達 11-22 小時
- PPID 為 1 或 Relay (已被 init 接管)

### 1.2 啟動時間追蹤

| PID   | 啟動時間            | 執行時長 | CPU%  |
| ----- | ------------------- | -------- | ----- |
| 46713 | 2026-02-10 23:52:47 | 22h48m   | 70.5% |
| 79657 | 2026-02-11 00:04:42 | 22h36m   | 80.9% |
| 94353 | 2026-02-11 02:35:35 | 20h05m   | 125%  |
| 59232 | 2026-02-11 03:01:21 | 19h39m   | 155%  |
| 92772 | 2026-02-11 11:14:54 | 11h25m   | 140%  |

### 1.3 產生源頭 (Root Cause)

**結論**: 這些 Orphan Process 來自 **TUI 模式異常終止**。

**證據**:

1. Session Storage 中無對應記錄 (代表未正常 shutdown)
2. 啟動時間集中在深夜/凌晨 (符合人工操作模式)
3. 多次啟動記錄 (可能為反覆嘗試連線或測試)

**觸發路徑**:

```
User 啟動 TUI (bun run dev / opencode)
   ↓
Terminal 異常終止 (Ctrl+C / SSH 斷線 / VS Code Remote 斷開)
   ↓
Signal Handler (thread.ts:177-179) 未被觸發
   ↓
ProcessSupervisor.disposeAll() 未被呼叫
   ↓
Child Process 變成 Orphan (被 init 接管)
   ↓
進入無窮迴圈 (Busy Loop) → 高 CPU 使用率
```

## 2. ProcessSupervisor 覆蓋率分析

### 2.1 已納管 (Registered)

| 模組                | 檔案路徑           | 納管狀況                         |
| ------------------- | ------------------ | -------------------------------- |
| Task (Subagent)     | `tool/task.ts:234` | ✓ 已註冊 (kind: `task-subagent`) |
| Task (Session Step) | `tool/task.ts:715` | ✓ 已註冊 (kind: `task-subagent`) |

### 2.2 未納管 (Unregistered)

#### 長期運行進程 (需納管)

| 模組                       | 檔案                              | Spawn 位置       | 風險等級   |
| -------------------------- | --------------------------------- | ---------------- | ---------- |
| **LSP Servers** (40+ 語言) | `lsp/server.ts`                   | 多處 `spawn()`   | **HIGH**   |
| **Bash Tool**              | `tool/bash.ts:177`                | `spawn(command)` | **MEDIUM** |
| **Session Prompt**         | `session/prompt.ts:1883`          | `spawn(shell)`   | **MEDIUM** |
| **Antigravity Plugin**     | `plugin/antigravity/index.ts:240` | `spawn(command)` | **LOW**    |
| **Gemini CLI Plugin**      | `plugin/gemini-cli/plugin.ts:365` | `spawn(command)` | **LOW**    |

#### 短期工具進程 (可豁免)

- `cli/cmd/auth.ts:273` - OAuth 瀏覽器啟動 (detached, 立即 unref)
- `cli/cmd/github.ts:336-339` - 開啟 URL (detached, 立即 unref)
- `file/ripgrep.ts:152,236` - ripgrep 搜尋 (短期執行, 有 timeout)
- `format/*.ts` - Formatter 檢測與執行 (短期執行)

## 3. 治理方案 (Governance Plan)

### Phase 1: 緊急修復 (✓ 已完成)

1. ✓ Kill 所有 Orphan Processes
2. ✓ `index.ts` finally block 加入 `ProcessSupervisor.disposeAll()`

### Phase 2: LSP 整合 (優先級 HIGH)

**目標**: 將所有 LSP Server processes 納入 ProcessSupervisor 管理。

**修改計劃**:

```typescript
// lsp/client.ts:247 (現有清理邏輯)
async shutdown() {
  connection.dispose()
  input.server.process.kill()  // ← 改為透過 ProcessSupervisor
  l.info("shutdown")
}

// lsp/index.ts:183-185 (spawn 時註冊)
const handle = await server.spawn(root)
ProcessSupervisor.register({
  id: `lsp-${serverID}-${Date.now()}`,
  kind: "lsp",
  process: handle.process,
  sessionID: undefined,  // LSP 為全域服務
})
```

### Phase 3: Bash Tool 整合 (優先級 MEDIUM)

**修改計劃**:

```typescript
// tool/bash.ts:177
const proc = spawn(params.command, { ... })

ProcessSupervisor.register({
  id: ctx.callID,  // 使用 Tool Call ID
  kind: "tool",
  process: proc,
  sessionID: ctx.sessionID,
})

// 在 kill() 或 exit 後清理
ProcessSupervisor.kill(ctx.callID)
```

### Phase 4: 監控與告警 (優先級 LOW)

**建立 Process Orphan 偵測機制**:

```typescript
// process/monitor.ts (新檔案)
export namespace ProcessMonitor {
  setInterval(() => {
    const snapshot = ProcessSupervisor.snapshot()
    const stale = snapshot.filter(
      (entry) => Date.now() - entry.lastActivityAt > 3600_000, // 1 hour
    )
    if (stale.length > 0) {
      Log.Default.warn("Stale processes detected", { count: stale.length })
    }
  }, 60_000) // 每分鐘檢查
}
```

## 4. 驗證與後續

### 驗證方式

1. 執行 TUI 模式後手動 Ctrl+C,確認所有 Child Process 被清理
2. 模擬 SSH 斷線,檢查是否產生 Orphan
3. 啟動 LSP Server 後執行 `ProcessSupervisor.disposeAll()`,確認全部終止

### 後續工作

- [ ] Phase 2: LSP 整合 (預計 2 天)
- [ ] Phase 3: Bash Tool 整合 (預計 1 天)
- [ ] Phase 4: 監控機制 (預計 1 天)

## 5. 關鍵決策記錄

1. **為何不在所有 spawn 點都強制註冊?**
   - 短期工具進程 (如 OAuth Browser, Ripgrep) 執行時間 < 10 秒,overhead 大於收益。
   - detached + unref 的進程已正確脫離父進程管理,不會成為 Orphan。

2. **為何優先整合 LSP?**
   - LSP 為長期運行進程,且數量多 (40+ 語言)。
   - 使用者長時間開發時,LSP 累積的 Orphan 風險最高。

3. **為何不刪除 LSP 自有的 cleanup 邏輯?**
   - 保留雙重保險 (LSP.shutdown() + ProcessSupervisor.disposeAll())。
   - LSP 的 Connection.dispose() 包含協議層清理,不可省略。
