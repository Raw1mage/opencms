# Event: Context Sharing v2

**Date**: 2026-03-27

## Requirement

將 SharedContext v1 的 8K snapshot injection 路線升級為真正的 parent-child message forwarding，並補齊 validation / architecture sync，使 context sharing v2 成為可收尾的 feature package。

## Scope

### IN
- 補齊 context sharing v2 plan artifacts（implementation-spec / handoff）
- 驗證 forward path / return path / compaction interaction
- 同步 architecture 文件，讓 V2 取代 stale 的 V1 authority 描述

### OUT
- 不新增 multi-child parallelism
- 不處理 grandchild context sharing
- 不重寫 SharedContext 結構
- 不在本輪重做 compaction framework

## Task List

1. 補齊缺失 plan artifacts
2. 將 T9-T12 具體化為可執行 validation contract
3. 建立本 event 文件
4. 更新 architecture 對 V2 的描述

## Debug Checkpoints

### Baseline
- `plans/20260327_context_sharing_v2/` 原本缺少 `implementation-spec.md` 與 `handoff.md`
- `docs/events/event_20260327_context_sharing_v2.md` 不存在
- `specs/architecture.md` 仍描述 V1 的 SharedContext snapshot injection / injectedSharedContextVersion / diff relay 路徑

### Instrumentation Plan
- 對照 proposal/spec/design/tasks 是否一致
- 檢查 architecture 是否仍與 V2 設計矛盾
- 將未具體化驗證項目轉成明確通過條件

### Execution
- 新增 `implementation-spec.md` 與 `handoff.md`
- 為 T9-T12 明確化 validation target、evidence 與 stop gates
- 建立 event 文件以承接後續驗證/決策證據
- 新增最小驗證測試：
  - `packages/opencode/src/session/compaction.test.ts`
  - `packages/opencode/src/session/prompt-context-sharing.test.ts`
  - `packages/opencode/src/session/usage-cache-reuse.test.ts`
  - `packages/opencode/src/session/usage-by-request.test.ts`
- 更新 `specs/architecture.md`，將 SharedContext / task handoff 描述同步為 context sharing v2 真相

### Root Cause
- context sharing v2 的核心實作與 tasks 草稿已存在，但 planner package 未補齊 execution contract / handoff / event / architecture sync，導致它作為完整 feature plan 不可收尾。

## Validation
- Plan package 現在包含：`proposal.md`、`spec.md`、`design.md`、`tasks.md`、`implementation-spec.md`、`handoff.md`、`idef0.json`、`grafcet.json`、`c4.json`、`sequence.json`
- T9（compaction oscillation 最低契約）：
  - 測試：`packages/opencode/src/session/compaction.test.ts`
  - 結果：2 pass / 0 fail
  - 證據：cooldown 內不會每輪重複 overflow compaction；接近 emergency ceiling 時仍會強制 compaction
  - 限制：屬單元層最低驗證，不是 child+parent-prefix 的完整多輪整合壓測
- T10（首輪 child message 組裝）：
  - 測試：`packages/opencode/src/session/prompt-context-sharing.test.ts`
  - 結果：1 pass / 0 fail
  - 證據：組裝順序為 full parent history → separator → child prompt messages
  - 限制：屬 source/unit 層驗證，未直接攔截真實 `processor.process()` 首次 payload
- T11（by-token cache reuse telemetry/accounting）：
  - 測試：`packages/opencode/src/session/usage-cache-reuse.test.ts`
  - 結果：1 pass / 0 fail
  - 證據：provider 若回傳 `cachedInputTokens`，系統會映射為 `tokens.cache.read` 並供 telemetry/accounting 使用
  - 限制：尚未做真實 provider round-2 live cache-hit integration 驗證
- T12（by-request cost posture）：
  - 測試：`packages/opencode/src/session/usage-by-request.test.ts`
  - 結果：1 pass / 0 fail
  - 證據：repo 對 by-request provider 採 `cost=0` posture，本地 accounting 對大 input token 仍維持 `usage.cost === 0`
  - 限制：僅證明本地 accounting / compaction posture，不等於外部供應商帳單實測

## Architecture Sync
Architecture Sync: Completed

Basis:
- `specs/architecture.md` 已改寫 Shared Context 章節：V2 以 parent message forwarding 為主橋接、移除 dispatch-time snapshot injection authority、保留 SharedContext 作 compaction / observability 與 merge target。
- 文件亦回填 2026-03-27 的驗證測試檔與證據邊界。 
