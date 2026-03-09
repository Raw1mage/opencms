# Event: syslog debug contract

Date: 2026-03-10
Status: In Progress

## 需求

- 將 system-level / syslog-style debug 思維導入所有開發與除錯流程。
- 標準化 debug checkpoints、instrumentation plan、component-boundary evidence gathering。
- 讓 `agent-workflow` 與 `code-thinker` 共用同一套 debug contract，而不是各自為政。
- 同步 repo / template / runtime skill，避免規範漂移。

## 範圍

### IN

- `/home/pkcs12/.local/share/opencode/skills/agent-workflow/SKILL.md`
- `/home/pkcs12/.config/opencode/skills/code-thinker/SKILL.md`
- `/home/pkcs12/projects/opencode/templates/skills/agent-workflow/SKILL.md`
- `/home/pkcs12/projects/opencode/templates/skills/code-thinker/SKILL.md`
- `/home/pkcs12/projects/opencode/AGENTS.md`
- `/home/pkcs12/projects/opencode/templates/AGENTS.md`
- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260310_syslog_debug_contract.md`

### OUT

- 不直接新增新的 debug skill 實作
- 不修改 runtime 程式碼行為

## 任務清單

- [x] 盤點現有開發 / debug workflow 入口與 skill 邊界
- [x] 定義統一的 syslog-style debug contract
- [x] 同步更新 agent-workflow / code-thinker（runtime + template）
- [x] 同步更新 AGENTS policy
- [x] 更新 event / architecture / parity 驗證

## Debug Checkpoints

### Baseline

- 現有流程只有「debug checkpoints 三段式」與零散的 RCA/謹慎寫碼要求。
- `code-thinker` 偏局部、靜態與最小修改；`agent-workflow` 偏全局 workflow，但兩者尚未共用統一 instrumentation / checkpoint schema。
- 若沒有 system-level / boundary-level evidence gathering，複雜 bug 很容易陷入局部猜測與反覆試錯。

### Execution

- 將 debug contract 統一成以下五段：
  1. `Baseline`
  2. `Instrumentation Plan`
  3. `Execution`
  4. `Root Cause`
  5. `Validation`
- 要求在 multi-component / multi-layer 問題中，必須先設計 component-boundary checkpoints，觀察進入/輸出/狀態傳遞，再判定 root cause。
- 把這套要求回寫到所有開發/除錯流程的入口文件與技能。
- 收斂 `AGENTS.md` / `templates/AGENTS.md`：只保留 repo 級 trigger / mandatory policy，將 checkpoint schema 細節回收到 `agent-workflow` 與 `code-thinker`，避免雙重維護。

### Validation

- `agent-workflow` runtime/template parity: MATCH
- `code-thinker` runtime/template parity: MATCH
- repo / template `AGENTS.md` 均已寫入 `全域 Debug / Syslog 契約（Mandatory）`
- repo / template `AGENTS.md` 已收斂為引用 shared debug contract，而非重複內嵌完整 schema
- Architecture Sync: Verified (Updated `docs/ARCHITECTURE.md` to record shared system-level debug contract across `agent-workflow` and `code-thinker`)
