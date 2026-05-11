---
date: 2026-05-11
summary: "Live verification — body carries x-codex-installation-id (cache still 4608 as expected for GPT-5.5 bug)"
---

# Live verification — body carries x-codex-installation-id (cache still 4608 as expected for GPT-5.5 bug)

## Evidence captured

**Resolver (production runtime)**
- File `~/.config/opencode/codex-installation-id` generated at 14:06:09 by daemon restart #1.
- Content: `42dbf4ca-fda0-44f9-ba52-2e4618b727c5` (valid v4 UUID, 36 bytes, mode 0644).
- Log line: `[codex-installation-id] resolved {"source":"generated"}` (seq 222).
- Idempotency confirmed: daemon restart #2 at 14:24:15 logged `source: "existing"` — file was reused, not regenerated.

**Body wire-shape (offline harness `/tmp/verify-body.ts`)**
- `resolveCodexInstallationId()` → `42dbf4ca-fda0-44f9-ba52-2e4618b727c5`.
- `buildResponsesApiRequest({ installationId: <uuid>, window: { conversationId: "conv-test", generation: 0 }, ... })` produces:
  ```json
  body.client_metadata = {
    "x-codex-installation-id": "42dbf4ca-fda0-44f9-ba52-2e4618b727c5",
    "x-codex-window-id": "conv-test:0"
  }
  ```
- Sibling key `x-codex-window-id` preserved (no regression in adjacent client_metadata entries).

**Live codex turn**
- Session `ses_1ea4a340dffeo1pYxgv2Y1O1Q2` ran successfully on `codex / gpt-5.5 / codex-subscription-pkcs12-sob-com-tw`.
- `[CODEX-WS]` body dump goes to `console.error` (stderr) not debug.log, so we don't have direct live body capture — but the offline harness exercises the same `buildResponsesApiRequest` code path with the same resolver-issued UUID, which is byte-for-byte what the live transport hands to OpenAI.

**Cache outcome**
- `cacheReadTokens: 4608` — exactly the stuck floor predicted by `openai/codex#20301` (server-side GPT-5.5 model regression, already closed-out on sibling spec `provider_codex-prompt-realign/` commit `458617657`).
- This is not a failure of this spec — it confirms the reframe: installation_id was never the cache root cause; this spec is upstream-alignment hygiene.

## Outcome

Wire-shape gap closed. The codex provider now sends `client_metadata["x-codex-installation-id"]` on every Responses turn, matching upstream byte-for-byte for this dimension. When OpenAI publishes a fix for `#20301` and cache behaviour returns to normal, installation_id will not be a confound in any future RCA on this code path.

## Remaining

- Decide whether to commit + advance to `verified`.
- Graduation (`/plans/` → `/specs/`) is user-only per AGENTS.md zone contract.
