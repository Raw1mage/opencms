# Proposal

## Why

- Daemon restart 後接續舊 session 繼續對話時，大量 runtime state 已因程式碼更新而靜默改變，但系統完全不做版本檢查或 state reconciliation
- 具體觸發場景：apply_patch tool schema 從 `{patchText}` 改為 `{input}` 後重啟 daemon，舊 session 的 message history 仍含舊格式 tool calls，導致 LLM 模仿舊格式呼叫 → 出錯
- Subagent worker 在 bootstrap 階段卡住時，因 Log 依賴 Bus（需 bootstrap 完成才初始化），形成 observability 死角 — 超時就是黑箱
- In-flight subagent task 在 daemon restart 後永久 orphan：父 session 的 ToolPart 卡在 `status: "running"`，無任何恢復機制

## Original Requirement Wording (Baseline)

- "查一下吧。尤其是針對這種 code update/daemon restart/session continuation 所可能衍生的各種缺口。我們是不是有一個 rebind 機制讓新啟動的 daemon 可以快速 pickup context? 但是舊版的 context 一定有很多因程式改版而不再合宜的設定？"
- "資訊量太大了，先寫 plan，再拆細成可執行工項。plan session-continuation-fix"

## Requirement Revision History

- 2026-04-15: Initial requirement from RCA of subagent worker timeout after code update + restart

## Effective Requirement Description

1. Daemon restart 後接續舊 session 時，必須偵測並處理版本不相容的 session state
2. Orphan task（daemon restart 時 in-flight 的 subagent）必須被偵測並恢復或標記失敗
3. Worker 子進程在 bootstrap 階段的失敗必須可被診斷（繞過 Bus 依賴的 observability 死角）
4. 歷史 tool call 的參數格式必須在 context 組裝時正規化，避免 LLM 模仿舊格式

## Scope

### IN

- Session version guard（偵測 + 警告 + graceful handling）
- Orphan task recovery（restart 時掃描 + 修復 stale ToolPart）
- Worker bootstrap observability（繞過 Bus 的 pre-bootstrap logging）
- Tool call input normalization（歷史 message 的 schema migration）
- Execution identity validation（帳號存活性檢查）

### OUT

- Session data format migration（Storage.ts 裡的 structural migration 不在此 plan）
- Compaction checkpoint 跨 model 相容性（複雜度高，另案處理）
- LLM prompt format 跨 provider 相容性（非 session continuation 問題）
- Tool schema 版本化系統（長期架構變更，非此 plan 範圍）

## Non-Goals

- 不做 session downgrade 支援（舊版 daemon 讀新版 session）
- 不做 session data 自動回滾
- 不重構 session storage 架構

## Constraints

- 所有改動必須向後相容：舊 session 必須能被新版 daemon 正常處理
- Worker 子進程的 pre-bootstrap log 不能依賴 Bus/Instance（尚未初始化）
- Orphan recovery 不能阻塞 daemon 啟動（async background task）
- Tool input normalization 只在 context 組裝時做，不修改已存的 message data

## What Changes

- `Session.get()` 增加 version check，回傳 `staleVersion` 標記
- `InstanceBootstrap()` 結束後增加 orphan task scan
- Worker `session.ts` 在 `bootstrap()` 之前加入直寫 fs 的 pre-bootstrap logger
- `prompt.ts` / `llm.ts` 在組裝 message context 時 normalize 舊格式 tool call inputs
- `processor.ts` 在使用 execution identity 前 validate account 存活性

## Capabilities

### New Capabilities

- **Version guard**: Session 載入時偵測版本不匹配，標記 `staleVersion` metadata
- **Orphan task recovery**: Daemon 啟動時自動偵測並修復 stale "running" ToolPart
- **Pre-bootstrap logger**: Worker 進程 bootstrap 前即可寫入診斷資訊
- **Tool input normalizer**: 歷史 tool call 的 schema drift 在 context 組裝時自動修正

### Modified Capabilities

- `Session.get()`: 增加 version 比對邏輯
- `SessionProcessor`: execution identity 使用前增加 account validation
- Worker lifecycle: 增加 pre-bootstrap stderr/file logging

## Impact

- `packages/opencode/src/session/index.ts` — Session.get() version guard
- `packages/opencode/src/session/processor.ts` — execution identity validation
- `packages/opencode/src/session/prompt.ts` 或 `llm.ts` — tool input normalization
- `packages/opencode/src/tool/task.ts` — orphan scan on bootstrap
- `packages/opencode/src/cli/cmd/session.ts` — worker pre-bootstrap logger
- `packages/opencode/src/project/bootstrap.ts` — orphan recovery trigger
