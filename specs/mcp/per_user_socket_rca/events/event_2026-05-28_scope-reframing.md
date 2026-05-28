# Event 2026-05-28 — Scope reframed from "per-user socket" to "registry contract hardening"

## Trigger

Phase 5 (docxmcp deployment alignment) preflight surfaced a hard contradiction
between this plan's design and docxmcp's own 2026-05-28 architecture decision.

## What was found

[docxmcp/docker-compose.yml](../../../docxmcp/docker-compose.yml) header comment
states explicitly:

> uvicorn binds the socket inside the container at 0666; combined with dir 0755
> the effect is "any local user on this host can connect" — intentional per
> 2026-05-28 decision to relocate off /run/user/${UID} (rootful docker daemon
> namespace cannot reach systemd user RuntimeDirectory).

Read as:

- docxmcp deliberately abandoned `/run/user/${UID}/...` because the rootful
  Docker daemon's mount namespace cannot reach systemd user `RuntimeDirectory`.
- The canonical IPC rendezvous is now `./.run/docxmcp.sock` inside the docxmcp
  repo — **not** a dev fallback.
- The socket is intentionally reachable by all local users (0666 / 0755).
- One docxmcp container per host serves all users on that host; no per-user
  isolation is intended.

## Conflict with this plan

This plan was framed as **per-user socket resolution**, assuming each user
needs their own MCP App socket under `$XDG_RUNTIME_DIR`. Specifically:

- proposal.md / design.md DD-2 / DD-6 prescribed templated URLs expanding to
  `unix:///run/user/<uid>/opencode/sockets/docxmcp/docxmcp.sock:/mcp/`.
- Phase 5 was about migrating docxmcp's deployment to match.

Both are factually wrong for docxmcp specifically. The intended target path is
unreachable from inside the rootful docker container; the migration would
have broken the currently-working connection.

## Decision

Reframe the plan from **"per-user socket resolution"** to **"MCP App
registry contract hardening"** — keep the layered merge, the URL resolver,
the install-target API, and the structured error, but stop claiming docxmcp
is the validation target.

- Layered merge fix (Phase 2) is correct on its own merits: system-wins
  collision rule was always wrong because it makes runtime overrides
  impossible. This stands regardless of which path docxmcp uses.
- URL resolver (Phase 3) is forward-looking utility for any future MCP App
  that legitimately wants templated paths. docxmcp does not need it; a
  literal URL passes through the resolver untouched.
- Install-target + structured error (Phase 4) are independent quality-of-life
  fixes for `system-manager_install_mcp_app`.
- docxmcp's `.run/docxmcp.sock` path is **canonical**, not "dev fallback".
  The current `~/.config/opencode/mcp-apps.json` user-tier entry pointing at
  it is **correct**, not stale. No mcp.json change. No Docker mount change.

## Impact on shipped work

Phase 2/3/4 code is still sound and stays merged:

- `packages/opencode/src/mcp/app-store.ts` — layered merge replacement is
  correct regardless of docxmcp specifics.
- `packages/opencode/src/mcp/url-resolver.ts` — closed token set + literal
  passthrough means it is safe for current docxmcp + ready for future apps.
- `packages/opencode/src/mcp/index.ts` and
  `packages/opencode/src/incoming/dispatcher.ts` — both call the resolver;
  with a literal URL they are no-ops.
- `packages/mcp/system-manager/src/index.ts` and
  `packages/opencode/src/server/routes/mcp.ts` — install-target + structured
  error are independent improvements.

Tests under `packages/opencode/test/mcp/` cover all of the above; 30 tests
pass, no regression.

## Forward changes (this plan's remaining scope)

- proposal.md / design.md / spec.md / handoff.md narrative rewritten to
  remove the docxmcp-per-user-deployment framing.
- DD-2 / DD-6 inverted: docxmcp is intentionally a host-shared socket;
  `.run/` is canonical for it per the 2026-05-28 docxmcp decision.
- Phase 5 reduced to "verify existing user-tier docxmcp entry stays
  correct" + "document the registry contract decision". No deployment
  edits.
- IDEF0 A5 / GRAFCET step 8 retitled from "align docxmcp deployment" to
  "verify deployment matches contract".
- Plan slug `mcp_per_user_socket_rca` retained (history continuity); the
  user-facing narrative inside the package is what carries the new
  framing.

## Methodology takeaway

Per memory `feedback_rca_look_before_failure.md`: first plausible cause was
incomplete. The rca.md was written without reading docxmcp's own
docker-compose.yml header comment, which contained the deliberate
counter-design. Phase 0 evidence collection should have included that
read; future RCAs touching a downstream system must do so.
