---
date: 2026-05-11
summary: "Stage A.3-2 wire rewrite landed"
---

# Stage A.3-2 wire rewrite landed

## What

`packages/opencode/src/session/llm.ts` 把 codex provider 的 system prompt 組裝改成上游對齊形態：

1. 計算 `useUpstreamWire`：codex provider 且 `OPENCODE_CODEX_LEGACY_INSTRUCTIONS!="1"` 時為 true
2. 新路徑下：staticBlock 用 driver-only tuple 重組（agent / agentsMd / userSystem / systemMd / identity 設為空字串）→ system[0] 變成只放駕駛員人格
3. 舊路徑（lite / 非 codex / flag on）保留：系統 push 完整 staticText、buildPreface、CONTEXT PREFACE 訊息插入
4. 新路徑下，`buildPreface` 整段被 `if (!useUpstreamWire)` 包住跳過
5. preface 插入區塊本來就 `if (preface)` 守衛，新路徑下 preface 為 undefined 自然 no-op
6. 在 preface 插入區塊**之後**新增 fragment 組裝邏輯：
   - 收集 fragment list：`RoleIdentity` → `OpencodeProtocolInstructions`（SYSTEM.md）→ `OpencodeAgentInstructions`（agent.prompt + user.system）→ `UserInstructions`×N（global+project AGENTS.md）→ `EnvironmentContext`
   - `assembleBundles()` 切兩個 bundle
   - 包成 `ModelMessage` 帶 `providerOptions.codex.kind = "developer-bundle" | "user-bundle"` marker
   - 插在最後一個 user 訊息**之前**（跟 preface 同樣插入點，保持位置語義）
7. 加 `prompt.bundle.assembled` log（替代將被廢的 `prompt.preface.assembled`）

對齊 [refs/codex/codex-rs/core/src/session/mod.rs:2553-2761](refs/codex/codex-rs/core/src/session/mod.rs#L2553-L2761) `build_initial_context()` 輸出的 input[] 順序：one developer item bundle → one user item bundle → conversation。

## Files

- `packages/opencode/src/session/llm.ts` (+170 lines, 新 imports + useUpstreamWire flag + driver-only static + fragment assembly + bundle injection)

## Verification

```
bunx tsc --noEmit                       clean (no new errors)
bun test test/session/context-fragments.test.ts   13 pass / 0 fail
bun test test/session/llm-rate-limit-routing.test.ts   2 fail (PRE-EXISTING — Account.knownFamilies missing, unrelated)
```

## Caveats

- 沒做 e2e validation（要 daemon rebuild + restart + 跑兩 turn 才看得到 cache_read 變化）
- subagent session 路徑也走新 wire（identity fragment 帶 "Subagent" 字樣）；尚未個別 regression test
- Plugin transform `experimental.chat.system.transform` 仍跑，但操作對象從多元素 system[] 變成 driver only — 預期 most plugins 仍能運作（hook 對單元素也合理）
- Stage A.3-5 的新 hook `experimental.chat.context.fragment.transform` 暫不實作（沒有 caller 需要它，等 plugin 開發者報需求再加）
- 圖片 inline / lazy catalog / structured output / quota / subagent return / enablement / attached images inventory 在新路徑下**暫時消失**（沒有對應 fragment）— Stage B.1+B.2 會逐個補上。短期影響：codex 跑的 session 看不到 lazy catalog 摘要、結構化輸出指示等。可以接受作為 Stage A 的 trade-off

## Next

- Stage A.5: daemon 啟動 broadcast `resetWsSession` 給每個 active codex session（避免舊 chain 在新 wire 結構下 4xx）
- Smoke test: rebuild + restart + 跑 2 turn，量 cache_read
- 若 cache_read 仍卡 4608 → 走更深 RCA
- Stage B.1+B.2: 補 OpenCode 自有 fragment（apps / available-skills / lazy-catalog / quota / subagent return / images inventory）

