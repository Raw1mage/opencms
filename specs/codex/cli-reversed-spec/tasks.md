# Tasks — codex-cli reversed spec

Reverse-engineering reference spec; "tasks" are chapter audit milestones, not implementation work.

- [x] Ch01 entry points — audited (SHA 76845d716b720ca701b2c91fec75431532e66c74)
- [x] Ch02 auth & identity — audited
- [x] Ch03 session & turn loop — audited
- [x] Ch04 context fragments — audited
- [x] Ch05 tools & MCP — audited
- [x] Ch06 Responses request build — audited
- [x] Ch07 HTTP/SSE transport — audited
- [x] Ch08 WebSocket transport — audited
- [x] Ch09 compact endpoint — audited
- [x] Ch10 subagents — audited
- [x] Ch11 cache & prefix model — audited
- [x] Ch12 rollout & telemetry — audited

All 12 chapters anchored on commit `76845d716b720ca701b2c91fec75431532e66c74`.

## Ongoing maintenance
Re-audit chapters against new upstream HEAD whenever codex-cli ships material protocol changes; recorded as events under `events/`, not as checklist items here.
