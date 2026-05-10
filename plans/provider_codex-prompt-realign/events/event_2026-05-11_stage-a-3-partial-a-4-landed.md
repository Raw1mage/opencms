---
date: 2026-05-11
summary: "Stage A.3 partial + A.4 landed"
---

# Stage A.3 partial + A.4 landed

## What

兩塊 wire-level 改動同時送出（互相不依賴，各自獨立可驗）：

### A.3 partial — convert.ts driver-only instructions + bundle marker

`packages/opencode-codex-provider/src/convert.ts`:
- `instructions` 欄位只取**第一個** system message；多餘的 system message 走 `console.error` log 後丟棄（不再 silent concat — 對齊 AGENTS.md no-silent-fallback rule）
- 新增 bundle marker 識別：user-role 訊息若帶 `providerOptions.codex.kind === "developer-bundle"` → emit 為 `role: "developer"` ResponseItem；其他 user-role 維持 `role: "user"`

這條讓上層 (`llm.ts`) 在 Stage A.3-2 改寫時可以用 `providerOptions.codex.kind` 把 developer-role bundle 標起來。

### A.4 — prompt_cache_key 純 threadId

`packages/opencode-codex-provider/src/provider.ts:161`：

```diff
-const cacheKey = threadId
-  ? `codex-${accountId || "default"}-${threadId}`
-  : this.window.conversationId
+const cacheKey = threadId ?? this.window.conversationId
```

對齊上游 codex-cli `prompt_cache_key = thread_id` ([refs/codex/codex-rs/core/src/client.rs:713](refs/codex/codex-rs/core/src/client.rs#L713))。

預期效果：多帳號 rotation 不再切碎 cache namespace；同 session 的所有 turn 共用一個 prefix-cache 範圍，跨 rotation cache_read 可累積。

新增/更新 fragment 框架補充：`opencode-agent-instructions.ts`（OpenCode-only fragment 承載 `agent.prompt` + `userSystem`，用 `<agent_instructions>` markers），給後續 A.3-2 的 wire 改寫用。

## Files

- `packages/opencode-codex-provider/src/convert.ts` (lines 29-77)
- `packages/opencode-codex-provider/src/convert.test.ts` (測試更新 + 新測試)
- `packages/opencode-codex-provider/src/provider.ts` (lines 157-170)
- `packages/opencode-codex-provider/src/provider.test.ts` (TV-6 註解 + 斷言更新)
- `packages/opencode/src/session/context-fragments/opencode-agent-instructions.ts` (新檔)
- `packages/opencode/src/session/context-fragments/index.ts` (re-export)

## Verification

```
codex-provider:
  bun test src/convert.test.ts        18 pass / 1 fail (pre-existing convertTools)
  bun test src/provider.test.ts       5 pass / 0 fail / 18 expect calls

opencode session:
  bun test test/session/context-fragments.test.ts   13 pass / 0 fail (unchanged)
  bunx tsc --noEmit                   no new errors
```

## Caveats

- A.3 主要工作（llm.ts 廢除 CONTEXT PREFACE、改 fragment 組裝、prepend bundles）尚未做。本次只動 convert.ts 拿前墊（讓 llm.ts 能用 marker 通報）。
- A.4 改了 cache_key 但**不會**自動修復現有 active sessions：那些 sessions 在升級前已建立的 disk-persisted continuation 仍標 `codex-{accountId}-{sessionId}` 形態。Stage A.5 處理 broadcast resetWsSession。本次升級後新建的 codex session 立即享受新 cache_key 行為。
- 連帶風險：transport-ws.ts 的 per-account WS swap 路徑跟 cache_key 是不同層的概念（swap 處理 chain id，cache_key 處理 prefix-cache namespace），swap 路徑邏輯不變。

## Next

- Stage A.3-2: llm.ts 改寫 — 移除 buildPreface/CONTEXT PREFACE 路徑，改成從 fragment producers 收集 → assembleBundles → prepend 兩個 bundle ModelMessage 到 `input.messages`，feature flag `OPENCODE_CODEX_LEGACY_INSTRUCTIONS=1` 走舊路徑
- Stage A.5: daemon 啟動偵測 legacy continuation state → broadcast resetWsSession
- Smoke test: rebuild + restart，跑 2 個 turn，確認 `cached_tokens` 第二 turn 顯著大於 4608

