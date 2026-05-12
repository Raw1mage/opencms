---
date: 2026-05-12
summary: "Architecture correction: transport-ws sites stay direct, dispatch at runloop"
---

# Architecture correction: transport-ws sites stay direct, dispatch at runloop

Phase E (M7-5) originally specified rewiring transport-ws.ts:561/571/581/607 in `@opencode-ai/codex-provider`. On inspection that path created a reverse package dependency (codex-provider would have to import from session/continuation). The architecturally correct dispatch point is at the runloop level where transport's failure outcome is observed — already in packages/opencode/.

Resolution:
- transport-ws.ts sites stay as primitive chain scrubs (`resetWsSession`, `doInvalidate`, length_not_grown, disk-continuation drop).
- prompt.ts isEmptyRound predicate extended to include `finish === "error"` (the server_failed bucket per the SSE classifier mapping).
- New branch in the empty-response site: when `finish === "error"`, dispatch `Continuation.run({ kind: "backend_failure_forced_resend", classifier: "server_failed" })`. When unknown/other, dispatch existing empty_response_recovery path.

Commit: `3cc9df530`. This closes the last跳針 path: pre-Phase E, server_failed rounds leaked past the runloop's chain-init dispatch because the predicate only matched unknown/other.</body>
