# webapp

> Wiki entry. Source of truth = current code under `packages/app/`,
> `packages/opencode/src/server/routes/`, `webctl.sh`,
> `/etc/opencode/web_routes.conf`, and `~/.config/web_registry.json`.
> Replaces the legacy spec packages `webapp/rich-rendering` and
> `webapp/voice-input` (both `living` as of 2026-04-10).

## Status

shipped (live as of 2026-05-04). `rich-rendering` and `voice-input`
both reached production. Markdown file viewer with Mermaid + SVG is in
`packages/app/src/pages/session/markdown-file-viewer.ts`; voice input
runs the dual-path (desktop SpeechRecognition + mobile MediaRecorder)
through `prompt-input.tsx`.

## Current behavior

### Stack and routing

The webapp is `packages/app/` — a SolidJS + Vite SPA
(`@opencode-ai/app`, v1.1.65). Routes declared in `src/app.tsx` via
`@solidjs/router`: `/` (Home), `/system/tasks/:jobId?` (TaskList),
`/:dir/session/:id?` (Session), `/:dir/session/:id?/tool/:tool`,
`/:dir/session/:id?/terminal-popout`. Provider stack is
`AppShellProviders` (Settings → Permission → Layout → Notification →
Models → Command → Highlights), authenticated by `WebAuthProvider` +
`AuthGate`.

`packages/web/` is **not** the webapp — it is the public Astro
documentation site (Starlight). The webapp itself ships only as
`packages/app/`.

### Build / dev flow

`webctl.sh` orchestrates the full lifecycle (see [daemon.md](../daemon/README.md)
for the full subcommand list). Webapp-specific verbs:

- `webctl.sh dev-start` — spawn dev backend
  (`bun --conditions=browser .../index.ts`) plus the Vite frontend
  dev server. Defaults: backend `OPENCODE_PORT=1080`, frontend
  `OPENCODE_FRONTEND_DEV_PORT=3000`.
- `webctl.sh build-frontend` — `vite build` produces
  `packages/app/dist/`.
- `webctl.sh dev-refresh` (alias of `restart`) — fingerprint-skip
  rebuild; in dev the frontend layer is skipped (Vite HMR handles it).
- `webctl.sh web-refresh` — production deploy frontend to
  `/usr/local/share/opencode/frontend/` and bounce
  `opencode-gateway.service`.

`OPENCODE_FRONTEND_PATH` in `/etc/opencode/opencode.cfg` tells the
gateway where to serve the built `dist/`.

### Gateway integration and route registration

Browsers terminate at the C gateway (port 1080, runs as root). The
gateway authenticates (PAM → JWT cookie `oc_jwt`), resolves the target
backend via `/etc/opencode/web_routes.conf` (longest-prefix match),
and splices bytes at L4. For the canonical opencode webapp, it
forks a per-uid `bun` daemon and splices to its Unix socket
(`$XDG_RUNTIME_DIR/opencode/daemon.sock`); for sibling webapps it
splices to a registered TCP `host:port`. Full splice / auth detail
lives in [daemon.md](../daemon/README.md).

Sibling webapps (`/cisopro`, `/linebot`, `/cecelearn`,
`/lifecollection`, `/warroom`, etc.) use a two-layer system:

- **`~/.config/web_registry.json`** — user-level declaration
  (`entryName`, `projectRoot`, `publicBasePath`, `host`, `primaryPort`,
  `webctlPath`, `enabled`, `access`). Used by webapp's introspection
  endpoints to know what *should* be reachable.
- **`/etc/opencode/web_routes.conf`** — system-level route table
  (`<prefix> <host> <port> <owner_uid> [auth]`). The gateway reads it
  at start and on `SIGHUP`; it is mutated by `webctl.sh publish-route`
  / `remove-route` over the gateway's `/run/opencode-gateway/ctl.sock`
  admin socket.

The `web-route.ts` server module also provides TCP probes
(`tcpProbe(host, port, timeoutMs)`) so the UI can show per-route
health.

### Multi-user model

One `bun` daemon per logged-in uid, all sharing one root gateway.
Production system accounts (`pkcs12`, `cece`, `rooroo`, `liam`,
`yeatsluo`, `chihwei`) each get their own daemon; the gateway uses
`uid` from the JWT to pick the socket. No state pollution across
daemons because each is a separate OS process with its own
`~/.config/opencode/` view (XDG-isolated). Login redirect clears
`localStorage` on cross-user switch.

### Admin Panel (`/admin`)

The webapp surfaces a "三合一管理界面" (per project AGENTS.md § main
分支主要特色) combining:

- **Provider / model management** — `dialog-manage-models.tsx`,
  reached from Settings → "Manage Models". Connect provider, pick
  default, toggle visibility, configure billing mode (token /
  request / unknown). Quota hints render in `format: "admin"` (full)
  vs `format: "footer"` (compact) per `quota-hint-cache.ts`.
- **Account management** — multi-account view backed by the global
  `accounts.json` (see [account.md](../account/README.md)).
- **App Market** — installer / catalog; see
  [app-market.md](../app-market/README.md).

### Rich rendering and voice input

`pages/session/markdown-file-viewer.ts` recognizes Mermaid via three
fence patterns (` ```mermaid `, `:::mermaid`, `<pre class="mermaid">`)
and renders through the pinned `mermaid` package (v11.12.0); on parse
failure it falls back to safe code presentation, never raw HTML
injection. `rich-markdown-surface.tsx` and `message-file-links.ts`
turn `path[:line]` references in assistant text into clickable links
that open the existing file tab and update selected-line state.

Voice input (`prompt-input.tsx`) picks one path at mount via
`voicePath()`:

- **Desktop** (`utils/speech.ts`) — `SpeechRecognition` with
  smart-punctuation (short pause → comma, 3 s silence → period or `？`
  for 嗎/呢, explicit stop → period). `continuous=true`. Snapshot-
  based prompt rebuild.
- **Mobile** (`utils/audio-recorder.ts` + `utils/transcribe.ts`) —
  `MediaRecorder` 1 s chunks (preferred MIME
  `audio/webm;codecs=opus` first), POST to
  `/api/v2/session/:sessionID/transcribe` (handler at
  `routes/session.ts` ~L2563) which auto-discovers an audio-capable
  model and returns `{text}` or `MISSING_AUDIO` / `INVALID_MIME` /
  `NO_AUDIO_MODEL` / `TRANSCRIPTION_FAILED`.

Both paths converge on `applyVoiceTranscript()` → `prompt.set()`. Auto-
stop on mode switch / AI working / cleanup. Unsupported state is
explicit (no silent fallback).

## Code anchors

Frontend:
- `packages/app/src/app.tsx` — router root, providers (L102–L141),
  `AppInterface` (L243).
- `packages/app/src/pages/layout.tsx` — chrome (opens
  `DialogAppMarket` at L1065).
- `packages/app/src/pages/session/markdown-file-viewer.ts` — Mermaid
  detection / extraction (L57–L84).
- `packages/app/src/pages/session/rich-markdown-surface.tsx`,
  `message-file-links.ts` — chat rich content + clickable
  `path[:line]`.
- `packages/app/src/components/prompt-input.tsx` — voice route
  selection.
- `packages/app/src/utils/{speech,audio-recorder,transcribe}.ts` —
  voice input plumbing.
- `packages/app/src/components/dialog-manage-models.tsx` — Admin
  Panel: provider / model.

Backend / orchestration:
- `packages/opencode/src/server/routes/session.ts` —
  `POST /:sessionID/transcribe` (~L2563).
- `packages/opencode/src/server/routes/web-route.ts` —
  `web_registry.json` introspection + TCP probe + ctl.sock bridge.
- `packages/opencode/src/server/routes/mcp.ts` — `/mcp/market`
  feeding the App Market dialog.
- `webctl.sh` — `do_build_frontend` (~L1934), `do_dev_start`
  (~L1162), `do_restart` (~L1507).
- `/etc/opencode/opencode.cfg` — `OPENCODE_FRONTEND_PATH`,
  `OPENCODE_PORT`, `OPENCODE_FRONTEND_DEV_PORT`.
- `/etc/opencode/web_routes.conf`, `~/.config/web_registry.json` —
  two-layer route registration.

Tests: `packages/app/src/utils/speech.test.ts` and
`pages/session/markdown-file-viewer.test.ts`,
`message-file-links.test.ts`.

## Notes

- Voice route selection is **final** for the component lifetime — no
  silent re-evaluation mid-session per the no-silent-fallback rule.
- `switch_gateway_mode dev|prod` toggles `OPENCODE_BIN` between
  `bun --conditions=browser .../index.ts` and
  `/usr/local/bin/opencode`, then bounces the gateway so newly forked
  daemons pick up the new binary.
- Sibling webapps are not opencode webapps; they share only the
  gateway's auth + splice infrastructure.

### Related entries

- [daemon.md](../daemon/README.md) — gateway, splice, per-user daemon
  lifecycle, `webctl.sh` verbs.
- [meta.md](../meta/README.md) — `/etc/opencode/` configuration surface.
- [session.md](../session/README.md) — session UI client, SSE/sync, prompt
  input, file-tab system.
- [app-market.md](../app-market/README.md) — App Market dialog inside the
  Admin Panel.
