# Event: High Load Bun Orphan Processes Fix

Date: 2026-02-11
Status: Done (完整修復,詳見 event_20260211_signal_handler_cleanup_explained.md)

## 1. 症狀與分析 (Symptoms & Analysis)

- **症狀**: 系統出現多個 CPU 使用率極高 (70% - 155%) 的 `bun` process。
- **觀察**:
  - Process Tree 顯示這些 process 多為孤兒 (Orphan)，PPID 為 1 或 Relay。
  - 這些 process 執行時間長達 11-22 小時。
  - 即使原始的 SSH/Terminal session 結束，這些 process 仍持續執行。
- **成因**:
  - **根本原因**: TUI 模式異常終止 (Ctrl+C / SSH 斷線) 時,Signal Handler 中缺少 `ProcessSupervisor.disposeAll()` 呼叫。
  - **錯誤假設**: 最初誤以為 `finally` block 能處理 Signal-based termination（實測證明不會執行）。

## 2. 解決方案 (Solution)

### 階段一：立即止血

- 強制終止 (Kill) 所有高負載的 Orphan Processes。
- PIDs: 59232, 92772, 94353, 79657, 46713。

### 階段二：程式碼修復

#### 修正歷程

1. **第一次嘗試（錯誤）**:
   - 在 `index.ts` finally block 加入 `ProcessSupervisor.disposeAll()`
   - **失敗原因**: finally block 在收到 SIGTERM/SIGHUP 時不會執行

2. **第二次嘗試（錯誤）**:
   - 在 `index.ts` 頂層註冊 Signal Handler
   - **失敗原因**: 與 TUI 模式的 Signal Handler 衝突,觸發雙重清理

3. **最終正確方案**:
   - **在 TUI Signal Handler (`thread.ts`) 中加入 `ProcessSupervisor.disposeAll()`**
   - 保留 `finally` block 作為 Non-TUI 模式的補充防護

### 修改檔案

1. `packages/opencode/src/cli/cmd/tui/thread.ts`
   - Import `ProcessSupervisor`
   - `handleTerminalExit()` 中加入 `ProcessSupervisor.disposeAll()`
   - 使用 `Promise.all()` 確保即使 worker RPC 失敗也能清理

2. `packages/opencode/src/index.ts`
   - Import `ProcessSupervisor`
   - 保留 `finally` block 中的 `ProcessSupervisor.disposeAll()` (Non-TUI 模式)

3. `packages/opencode/src/cli/cmd/tui/worker.ts`
   - 加入註解說明清理機制

## 3. 驗證 (Verification)

- 已手動 kill 孤兒 process，系統負載恢復正常 (從 14.57 → 3.84)。
- 三層防護機制已建立:
  1. TUI Signal Handler (處理 Terminal 斷線、Ctrl+C)
  2. Worker Shutdown (處理正常退出)
  3. Finally Block (處理 Exception)

## 4. 技術細節

### 為何 Signal Handler 是正確方案？

```typescript
// ❌ 錯誤：finally 在收到訊號時不執行
try {
  await cli.parse()
} finally {
  await ProcessSupervisor.disposeAll() // ← 收到 SIGTERM 時不會執行
}

// ✅ 正確：Signal Handler 能捕捉所有終止訊號
process.on("SIGTERM", async () => {
  await ProcessSupervisor.disposeAll() // ← 必定執行
  process.exit(0)
})
```

### 驗證方式

```bash
# 測試 1: 模擬 SSH 斷線
kill -SIGHUP <PID>

# 測試 2: Ctrl+C 中斷
# (Press Ctrl+C in TUI)

# 測試 3: 檢查殘留 Process
ps aux | grep "bun.*opencode" | wc -l
# 預期結果: 0
```

## 5. 後續工作

詳見 `event_20260211_process_supervisor_governance.md`:

- Phase 2: LSP Servers 整合 (40+ 語言 Server)
- Phase 3: Bash Tool 整合
- Phase 4: 監控與告警機制

詳細機制說明見: `event_20260211_signal_handler_cleanup_explained.md`
