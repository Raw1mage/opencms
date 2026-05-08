# opencode specs/ — product wiki

This directory is a **descriptive product wiki** plus a small set of
**lifecycle-tracked sub-packages**. The source of truth for behavior
is the **current code**, not a forward-looking plan; the source of
truth for change history is the per-package plan-builder
`.state.json` lifecycle (see [meta/](./meta/README.md)).

## Tree structure

```
specs/
├── README.md              # this file
├── architecture.md        # cross-cutting index / decision log
├── _archive/              # frozen historical packages (read-only)
│
├── account/               # account model, accounts.json, OAuth, multi-user gateway
├── app-market/            # three-kind unified install surface, admin panel installer
├── attachments/           # image / docx / repo-tracked attachment lifecycle
├── compaction/            # context reduction, KV-cache, anchor / journal / pinned-zone
│   ├── working-cache/         # L1 (digest) + L2 (raw ledger) MVP — folded plan
│   ├── itemcount-fix/         # gpt-5.5 itemCount triggers — living
│   ├── empty-turn-recovery/   # empty-turn self-heal gate — implementing PAUSED
│   └── empty-response-rca/    # empty-response RCA + itemCount addendum — implementing
├── daemon/                # C gateway + per-user bun daemon, webctl.sh, restart_self
│   └── self-restart-handover/ # restart handover checkpoint — folded plan
├── harness/               # agent loop, autonomy, runloop, scheduler, mandatory skills
│   └── autonomous-opt-in/     # in-flight: R1/R2/R3 spec-binding + question arm
├── mcp/                   # MCP framework, manifests, idle unload, direct render
├── meta/                  # plan-builder skill, architecture doc flow, config mgmt
├── provider/              # cross-provider abstraction (registry, family, lmv2)
│   ├── claude/                # anthropic + claude-cli + claude takeover import
│   │   └── claude-session-list/   # sidebar tab + import/delta + anchor — folded plan
│   └── codex/                 # codex AI-SDK authority + WS layer + compaction
│       ├── codex-update/          # codex feature update spec — living
│       └── ws-snapshot-hotfix/    # WS snapshot interaction — verified
├── session/               # session storage, capability layer, rebind, dialog stream
│   └── continuation-fix/      # orphan-task recovery, version guard — needs-update
└── webapp/                # SolidJS SPA, Admin Panel, route registration, voice input
```

## Top-level wiki entries

| Entry | What it covers |
|---|---|
| [account/](./account/README.md) | Account model, `accounts.json`, multi-account auth, OAuth flows, family-normalization, multi-user gateway model. |
| [app-market/](./app-market/README.md) | Three-kind unified install surface (mcp-server / managed-app / mcp-app), Admin Panel installer. |
| [attachments/](./attachments/README.md) | Image / docx / repo-tracked attachment lifecycle, AI opt-in re-read, docxmcp HTTP-over-unix-socket transport. |
| [compaction/](./compaction/README.md) | Context reduction, KV-cache hardening, anchor / journal / pinned-zone, idle gate, hybrid LLM compaction, codex server-side compaction, Working Cache, empty-response gate. |
| [daemon/](./daemon/README.md) | C gateway + per-user bun daemon, `webctl.sh`, `restart_self`, daemon.lock, DAEMON_SPAWN_DENYLIST, self-restart handover. |
| [harness/](./harness/README.md) | Agent loop & autonomy, subagent dispatch & quota, mandatory skills preload, question tool, scheduler / heartbeat. (Renamed from `agent-runtime/` 2026-05-09.) |
| [mcp/](./mcp/README.md) | MCP framework, McpAppManifest + ManagedAppRegistry split, idle unload (proposed), Direct Render TODO. |
| [meta/](./meta/README.md) | plan-builder skill, architecture documentation flow, config management (XDG, `/etc/opencode/`, `tweaks.cfg`). |
| [provider/](./provider/README.md) | Cross-provider abstraction (registry, family, dispatch, LMv2 envelope). Per-provider detail under `provider/claude/` and `provider/codex/`. |
| [session/](./session/README.md) | Session storage (SQLite), capability layer / rebind, HTTP poll cache, frontend lazyload, mobile tail-first, dialog stream, continuation orphan recovery. |
| [webapp/](./webapp/README.md) | SolidJS SPA, Admin Panel `/admin`, route registration, voice input, rich rendering. |

## Conventions

### Tree balance

The wiki tree is intentionally shaped to keep depth and branching
roughly balanced, so no single topic dominates the navigation:

- **Top level** holds 10 entries — small enough to skim, large
  enough that no single topic monopolises.
- **One level of nesting** is allowed when a topic has either
  (a) a natural sub-domain (`provider/claude/`, `provider/codex/`),
  or (b) a folded plan / fix / RCA package whose lifecycle is
  worth preserving (e.g. `compaction/working-cache/`,
  `compaction/itemcount-fix/`, `daemon/self-restart-handover/`,
  `harness/autonomous-opt-in/`,
  `provider/claude/claude-session-list/`,
  `provider/codex/codex-update/`,
  `provider/codex/ws-snapshot-hotfix/`,
  `session/continuation-fix/`).
- **Two levels of nesting** is reserved for `provider/<vendor>/<slug>/`
  where the per-vendor sub-domain itself hosts multiple
  lifecycle-tracked packages.
- When adding new content, prefer **growing an existing entry** over
  creating a new top-level entry. New top-level entries are
  warranted only when the topic has its own code surface that
  doesn't fit any existing entry.

### Source of truth

- Wiki entry = source of truth is the **code**, not a plan.
- Sub-package (`<entry>/<slug>/`) = lifecycle-tracked spec with its
  own `.state.json`. Used for:
  - In-flight features that haven't reached `living` yet.
  - Folded plans whose lifecycle history is worth preserving.
  - Bug fixes / RCAs whose **evidence chain + test vectors**
    matter even after they ship.
- There is **no separate `issues/` bucket**. A fix's home is the
  topic where its **code lives** — not a generic "fixes" folder.
  When a fix's symptom is in topic A but the patch lands in topic
  B, B is the home; A links to it via `### Related entries`.

### Where new content goes

| Kind of change | Where it lands |
|---|---|
| New runtime behavior, in-flight | `<topic>/<slug>/` (sub-package, lifecycle-tracked) |
| New runtime behavior, shipped + verified | Folded into `<topic>/README.md` (lifecycle folder kept alongside if its history is worth preserving) |
| Bug fix or RCA | `<topic>/<slug>/` under the topic that owns the **patch site**, regardless of where the symptom appears |
| Brand-new subsystem | New top-level entry — but verify it doesn't fit an existing one first |
| Plan that hasn't started | Stays under `/plans/<slug>/` until it has shipped or is at least `designed` |

### Cross-linking

Wiki entries are a graph, not a tree of ownership. When a behavior
cuts across topics:

- **Primary home**: the topic with the strongest source-of-truth
  claim (where the code lives, not where the symptom shows up).
- **Cross-link**: every other affected topic adds a
  `### Related entries` link back, and may add a
  `## Cross-cutting <name> work` section that enumerates the
  related sub-packages from other topics.

Example: `compaction/empty-turn-recovery/` lives in compaction
because the storm-prevention gate code is in `SessionCompaction.run`,
even though the symptom is a codex empty turn.
`provider/codex/README.md` links to it from a
`## Cross-cutting empty-response work` section.

### Folded plans

Completed plan packages from `/plans/<date>_<slug>/` are folded
into the matching topic entry on `living`. The folder is `git mv`'d
in place under the topic (e.g. `compaction/working-cache/`) — not
deleted — so the proposal / design / tasks / handoff history stays
recoverable. The README of the parent entry summarises the shipped
behavior; the sub-folder retains the lifecycle artifacts.

If the plan never ships (stuck at `proposed`), it stays in
`/plans/<slug>/` and does not enter `specs/`.

### Per-folder file shape

Wiki entries (`<topic>/README.md`) follow:

1. `# <topic>` heading
2. Blockquote naming source folders / scope / replaced legacy specs
3. `## Status` — what's shipped, what's partial
4. `## Current behavior` — the actual semantics
5. `## Code anchors` — file paths with line numbers
6. `## Sub-packages` (if any) — links into nested `<slug>/`
7. `## Cross-cutting <name> work` (optional) — links to sub-packages
   under other topics that share the same symptom complex
8. `## Notes` / `### Related entries` — open questions, deprecations

No `proposal.md / design.md / tasks.md / .state.json` artefacts at
the wiki-entry level. Those live only inside `<topic>/<slug>/`.

## Index / cross-cutting

- [architecture.md](./architecture.md) — cross-cutting architecture
  document. Per-feature detail lives in the wiki entries above; this
  remains the high-level index and decision-log narrative.
- [meta/](./meta/README.md) — plan-builder skill, AGENTS.md split,
  XDG / `tweaks.cfg` config layer. Read this before adding a new
  spec package.

## Archive

- [_archive/](./_archive/) — frozen historical packages (the
  original 41 plan-builder packages, plus any later retirements).
  Cross-referenced by `architecture.md`, `docs/events/**`, and the
  `Replaces the legacy spec packages` notes at the top of each wiki
  entry.

## See also

- `/plans/` — pre-`designed` proposals that haven't entered the
  spec lifecycle. As of 2026-05-09 the un-shipped ones are
  `20260320_remote-terminal/`, `daemon-agent/`,
  `subagent-taxonomy/`. Shipped plans have already been folded
  into their topic entries.
- `/docs/events/` — per-event change log; phase-boundary entries
  written by `plan-builder` during `implementing` state.
- `/refs/` — read-only git submodules used as architectural
  reference (`refs/codex` pinned to `rust-v0.125.0-alpha.1`,
  `refs/claude-code` for anthropic CLI fingerprint, etc.).
