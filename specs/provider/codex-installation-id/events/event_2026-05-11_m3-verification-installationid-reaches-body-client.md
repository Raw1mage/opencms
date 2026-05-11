---
date: 2026-05-11
summary: "M3 verification — installationId reaches body.client_metadata on both HTTP and WS transports"
---

# M3 verification — installationId reaches body.client_metadata on both HTTP and WS transports

Traced `installationId` through `packages/opencode-codex-provider/`:

- `provider.ts:82-83` (`buildResponsesApiRequest`) passes `input.installationId` into `buildClientMetadata`.
- `provider.ts:199` propagates `this.options.installationId` from per-instance constructor options on the WS path.
- `provider.ts:371` passes `installationId` into `buildHeaders` for HTTP SSE fallback — but `headers.ts` does NOT emit an HTTP header for it. This is dead-pipe-by-design (DD-3): only `buildClientMetadata` writes the field, and it writes it into `body.client_metadata["x-codex-installation-id"]`, exactly where upstream emits it on the streaming Responses path.
- `transport-ws.ts:273-294` (`wsRequest`) receives the full `body` (already containing `client_metadata.x-codex-installation-id`) and strips only `stream` / `background` before forwarding to the first WS frame. The field rides in the JSON body, never as a WS handshake header — matches upstream.

Conclusion: no code change needed in the provider package. The fix landed entirely in `packages/opencode/src/plugin/codex-installation-id.ts` (resolver) and `codex-auth.ts` (one-line plumb).

Operator surface (M6): nothing operator-visible beyond the new file `~/.config/opencode/codex-installation-id` (mode 0644, single v4 UUID). No CLI flag, no schema change, no telemetry — UUID value is not logged at info-level (only `log.info("resolved", { source })` records the kind of resolution, never the value itself).
