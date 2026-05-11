---
date: 2026-05-11
summary: "Add wire datasheet for stdio / Streamable HTTP / SSE + bundle_tar_b64"
---

# Add wire datasheet for stdio / Streamable HTTP / SSE + bundle_tar_b64

2026-05-11 release-prep documentation pass.

Added `specs/mcp/datasheet.md` — per-miatdiagram §4.4 mandatory
artifact for wire-touching subsystems. Covers:

1. **Transport: stdio** — newline-delimited JSON-RPC 2.0 over child
   stdin/stdout; field-by-field table (jsonrpc / id / method /
   params / result / error).
2. **Transport: Streamable HTTP** — POST + optional SSE response;
   includes OpenCMS-specific unix-domain-socket URL form
   `/<socket>:/path` (parseUnixSocketUrl in mcp/index.ts ~L20).
3. **Transport: SSE** — legacy fallback only.
4. **Method coverage subset** OpenCMS actually uses: initialize,
   notifications/initialized, tools/list, tools/call,
   resources/list, prompts/list, notifications/tools/list_changed.
5. **`tools/call` content[] variants** (text / image / resource).
6. **OpenCMS extension `structuredContent.bundle_tar_b64`** — the
   mcp-app file-bundle return channel (sanctioned IPC, no
   bind-mount). Producer ref: docxmcp `_maybe_build_bundle`.
   Consumer: `incoming/dispatcher.ts` `after()`.

Cross-referenced from main README under new "Wire datasheet" section
between Current behavior and Code anchors. Status date bumped from
2026-05-04 to 2026-05-10 to acknowledge recent shipped fixes
(google token auto-refresh, home-dir expansion).
