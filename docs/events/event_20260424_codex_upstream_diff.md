# Upstream codex diff triage (rust-v0.122.0 → rust-v0.125.0-alpha.1)

日期：2026-04-24
Spec：`specs/codex-fingerprint-alignment/` Phase 3 task 2.3

## Scope

檢查 upstream `refs/codex/codex-rs/core/src/client.rs` 與
`refs/codex/codex-rs/login/src/auth/default_client.rs` 是否新增**必要**
（非 conditional）的 header / body 欄位。依 errors.md E-FP-003 判斷是否觸發
`revise` mode。

## Commit range

```
5882f3f95e refactor: route Codex auth through AuthProvider (#18811)
f67383bcba [rollout_trace] Record core session rollout traces (#18877)
69c8913e24 feat: add explicit AgentIdentity auth mode (#18785)
ef00014a46 Allow guardian bare allow output (#18797)
c5e9c6f71f Preserve Cloudfare HTTP cookies in codex (#17783)
be75785504 fix: fully revert agent identity runtime wiring (#18757)
```

## Findings

### 不影響 fingerprint 的內部重構
- **#18811** AuthProvider 重構（`AuthorizationHeaderAuthProvider` 移除／重新連線）
- **#18877** rollout tracing（`CompactionTraceContext`、`InferenceTraceAttempt`、`InferenceTraceContext`）— 純內部 telemetry，不影響出站 header
- **#18785** / **#18757** AgentIdentity auth mode 新增後又 revert — net zero
- **#18797** guardian bare allow output — 與 request emission 無關

### 值得關注：Cloudflare cookie 持久化 (#17783)
`default_client.rs` 新增 `with_chatgpt_cloudflare_cookie_store`，upstream 改為
在 reqwest client 保留 ChatGPT Cloudflare cookies。

- **是否為必要 header**：不是 — 這是 reqwest client 層級的 cookie jar，不是 request-level header。
- **對 fingerprint 影響**：間接。在 CF 有 challenge 或速率限制的情境下，保留 cookie 可能讓 classifier 對 session 有更連續的識別；但穩態情境下的 first-party 判定應該不受此影響。
- **建議**：不阻擋 Phase 3。列為 follow-up candidate — 若 §3 beta soak 結果顯示 7% 未降到 <1%，再另開 spec 評估 TS 側是否要加 cookie jar。

### UA 格式
`DEFAULT_ORIGINATOR = "codex_cli_rs"` 不變；UA prefix rule 不變。我們的
`buildCodexUserAgent()` 行為仍對齊。

## Decision

- **No blocker for Phase 3** — 無新的必要 header / body 欄位。
- 不觸發 `revise` mode。
- 繼續 task 2.4 / 2.6（refs/codex 已 commit 到 tag，剩 `CODEX_CLI_VERSION` 常數更新）。

## Follow-up candidates (NOT in this spec)

- 若 Phase 1+3 後 first-party 比例仍 > 1%：評估 Cloudflare cookie jar 是否值得在 TS plugin 實作（需另開 spec，屬 Non-Goals 的 TLS/JA3 同層之外的 session-state 問題）。
