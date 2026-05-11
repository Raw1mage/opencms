# meta

> Wiki entry. Source of truth = current code under
> `packages/opencode/src/config/`, `packages/opencode/src/global/`,
> the `templates/` deployment surface, and the `~/projects/skills/plan-builder/`
> skill. Replaces the legacy spec packages `plan-builder`,
> `global-architecture`, and `config-management` (still on disk under
> `specs/`; will move to `specs/_archive/` on next touch).

## Status

shipped — all three meta-layer concerns are live as of 2026-05-04.

`plan-builder` skill is in production at `~/projects/skills/plan-builder/`
(SKILL.md + 9 scripts + state schema + templates) and has fully
displaced the legacy `planner` skill. The wiki conversion you are
reading right now (`compaction/`, `session/`, `provider/` (with
`provider/claude/` and `provider/codex/` sub-entries),
`attachments/`, `harness/` (formerly `agent-runtime/`), this file)
was authored against
`plan-builder`'s `living`-state model: each wiki entry is the public
projection of one or more `specs/<slug>/` packages whose lifecycle has
reached `living`.

`config-management` (Phase 1–3) is shipped: `Config` namespace has
last-known-good snapshot + 503 (not 500) error path + section-isolated
sub-file loads, and `disabled_providers` is now derived from
`accounts.json` with optional `providers.json` override.

`global-architecture` is the IDEF0 + GRAFCET reverse-engineering of the
codebase as of 2026-Q1; the diagrams are in `specs/_archive/global-architecture/`
and traceability matrices remain valid. The detailed per-subsystem
narrative lives in `specs/architecture.md` and the per-topic wiki entries
linked at the bottom.

## Plan-builder

### What the skill does

`plan-builder` is the single skill for any spec lifecycle action — new
spec, in-flight revision, on-touch migration of legacy `plans/<slug>/`,
SSDLC-evidence generation, archival. It replaces the deprecated
`planner` skill, which is retained only as a legacy alias for
unmigrated `/plans/` packages.

The skill is **prompt + bun-executed scripts**, not MCP. SKILL.md
carries the judgment; scripts under `~/projects/skills/plan-builder/scripts/`
carry the stateful operations.

### Seven lifecycle states

Each `specs/<slug>/.state.json.state` is one of:

| # | State | Means | Required artifacts |
|---|---|---|---|
| 1 | `proposed` | Initial why / scope | `proposal.md` + `.state.json` |
| 2 | `designed` | Architecture + contracts | + `spec.md`, `design.md`, `idef0.json`, `grafcet.json`, `c4.json`, `sequence.json`, `data-schema.json` |
| 3 | `planned` | Tasks broken down | + `tasks.md`, `handoff.md`, `test-vectors.json`, `errors.md`, `observability.md` |
| 4 | `implementing` | Build in progress | tasks partially checked |
| 5 | `verified` | Tests + evidence pass | all tasks checked + validation evidence |
| 6 | `living` | Merged to main; spec = current code | same as `verified`, kept current via `sync` |
| 7 | `archived` | Frozen, read-only | same as `living`, frozen |

`plan-validate.ts` is state-aware: it only checks artifacts required for
the current state. Missing future-state artifacts are not blockers.

### Seven change modes

Mode lives in each `.state.json.history` entry. Allowed transitions:

| Mode | Allowed transition | Use |
|---|---|---|
| `new` | (none) → `proposed` | Brand-new spec |
| `promote` | N → N+1 forward | Natural advance |
| `amend` | `living` → `living` | Bug fix within existing requirements |
| `revise` | `living` → `designed` | Scope adjustment |
| `extend` | `living` → `designed` | New requirement / capability |
| `refactor` | `living` → `proposed` | Architecture-level rewrite (auto-snapshot to `.history/refactor-YYYY-MM-DD/`) |
| `sync` | same-state | Reconcile code drift; warn-strategy, non-blocking |
| `archive` | `living` → `archived` | Feature retired |

Mode is classified objectively from the kind of change (code-only →
`skip-plan-builder`; Decision text edit → `amend`; new Phase → `revise`;
new `### Requirement:` → `extend`; data-schema break → `refactor`),
not by subjective small/medium/large judgment.

### `living` state and this wiki

The wiki entries in `specs/*.md` are the canonical reading surface for
specs in `living` state. Each `living` package's source-of-truth claim
("current behavior" + "code anchors") is folded into a top-level wiki
entry so newcomers read one file per topic instead of crawling several
`/specs/<slug>/` folders. The legacy spec packages remain under
`specs/<slug>/` as historical reference until peacefully migrated to
`specs/_archive/`.

### Where the scripts live

All under `~/projects/skills/plan-builder/scripts/`:

- `plan-init.ts` — create `specs/<slug>/proposal.md` + `.state.json`
- `plan-state.ts` — print current state; auto-migrate legacy if needed
- `plan-validate.ts` — state-aware validation
- `plan-promote.ts` — forward state advance or non-forward mode application
- `plan-migrate.ts` — explicit legacy `plans/<slug>/` migration
- `plan-archive.ts` — promote to `archived`; optional folder move
- `plan-gaps.ts` — code-independence readiness report
- `plan-sync.ts` — drift detection (warn strategy)
- `plan-rollback-refactor.ts` — restore from `.history/refactor-*/`
- `build-mode.ts` — runtime plumbing for `beta-workflow` admission

Shared libs in `scripts/lib/`: `state-inference.ts`,
`ensure-new-format.ts`, `inline-delta.ts`, `snapshot.ts`. Every
write-script entry calls `ensureNewFormat()` first; read-only scripts
also call it so viewing a legacy path upgrades it.

### On-touch peaceful migration

`ensureNewFormat(path)` is idempotent. On first touch of a legacy
`plans/<slug>/`:

1. `inferState(path)` from artifact combination (deterministic table; no
   silent default — `StateInferenceError` on ambiguous cases per
   AGENTS.md rule 1)
2. `cp` snapshot to `specs/<slug>/.archive/pre-migration-YYYYMMDD/`
3. `git mv plans/<slug>/ specs/<slug>/` (preserves history)
4. Write `.state.json` with inferred state + `migration` history entry
5. Log every step prefixed `[plan-builder-migrate]`

### Three-layer history

Per-part document history without overwrite:

1. **Inline delta markers** — strikethrough + `(vN, ADDED YYYY-MM-DD)`
   prefix on Requirements / Scenarios for `amend` / `revise` / `extend`
2. **Section-level supersede** — `[SUPERSEDED by DD-7]` tags on
   Decisions; both old and new entries kept
3. **Full snapshot** — `refactor` mode `git mv`s all artifacts (except
   `proposal.md`) to `specs/<slug>/.history/refactor-YYYY-MM-DD/` and
   resets current files to `proposed`-stage skeleton;
   `plan-rollback-refactor.ts` reverses

### Sync as mandatory checkpoint

`beta-workflow` invokes `plan-sync.ts specs/<slug>/` after every task
checkbox toggle. Sync diffs git changes against `data-schema.json`
fields, `errors.md` codes, `test-vectors.json` cases. Drift is
**warned not blocked** (exit code always 0). Even `clean` runs append
`{mode: "sync", result: "clean"}` to `.state.json.history` so the audit
trail shows continuous attention rather than silence.

## Architecture documentation

### `specs/architecture.md` — the index / cross-cutting view

The big architecture doc (~126KB) is the global single-source-of-truth
for cross-cutting structure: layered architecture (Infrastructure / Sync
/ Control / Feature / UI), provider abstraction, multi-account
management, rotation3D, admin panel, registry-first provider universe.
After per-topic wiki conversion, `architecture.md` is no longer the
authoritative narrative for any single subsystem — it is the index that
points to `compaction/`, `session/`, `provider/` (and its
`claude/` and `codex/` sub-entries), `attachments/`, `harness/`,
`daemon/`, `mcp/`, `account/`, `webapp/`, `app-market/`, and this
`meta/`. Each `Architecture Sync`
checkpoint at the top of `architecture.md` records "Verified (No doc
changes)" or links to the topic wiki updated in that change.

### `specs/_archive/global-architecture/` — IDEF0 + GRAFCET reverse engineering

A one-shot reverse-engineering snapshot of the codebase produced via
the `miatdiagram` skill:

- **IDEF0 functional decomposition**: A0 context (6 subsystems) →
  L1 (31 activities) → L2 (25 activities) — total 67 activities
- **GRAFCET state machines**: 7 independent models — session loop,
  gateway TCP, daemon lifecycle, MCP app, rotation3D fallback,
  workflow runner, tool execution — total 66 steps
- **Traceability**: `traceability_matrix.json` maps every GRAFCET step
  to a valid IDEF0 ModuleRef (100% coverage); `evidence_trace.json`
  cites source code per activity; `confidence_notes.json` flags
  inferred assumptions

This snapshot stays in `specs/_archive/global-architecture/` as historical
reference. Live updates flow into per-topic wiki entries; the IDEF0 /
GRAFCET artifacts are not regenerated on every change.

### `refs/` — upstream + research submodules

`refs/` carries read-only git submodules used as architectural reference
or fingerprint source. Active entries include `refs/codex` (pinned to
`rust-v0.125.0-alpha.1` for codex-rs protocol parity, see
[provider.md](../provider/README.md)), `refs/claude-code` (anthropic CLI
fingerprint source), `refs/openspec`, and `refs/agentmemory`
(`rohitg00/agentmemory`, added 2026-04-30 as research input for a future
knowledge-management layer; no production code consumes it yet).
Submodules under `refs/` are never modified in-tree; integration ideas
are recorded in `docs/events/` rather than vendored.

### `docs/events/` — change log

Per-event narrative records of significant decisions, incidents, and
architectural shifts. Filename convention:
`event_YYYYMMDD_<topic>.md`. Examples already on disk:
`event_2026-04-17_config_crash.md`,
`event_2026-04-18_plan-builder_launch.md`,
`event_2026-04-20_frontend_oom_rca.md`. `plan-builder`'s phase summary
ritual (§16.4 of SKILL.md) writes phase-boundary entries here during
`implementing` state.

### Two AGENTS.md files

- **`/home/pkcs12/projects/opencode/AGENTS.md`** — project-specific.
  Contains opencode-only rules: XDG config backup whitelist policy,
  daemon lifecycle authority (only `system-manager:restart_self` may
  restart the daemon; `bash` tool's `DAEMON_SPAWN_DENYLIST` enforces
  this), `enablement.json` dual-source synchronization, `templates/`
  deployment architecture, fail-fast web runtime entry point.
- **`~/.config/opencode/AGENTS.md`** — global. Universal rules
  (Plan / Fallback / Continuation / Autonomous Agent core discipline /
  Mandatory Skills / Debug Contract / Infrastructure). Loaded by every
  agent invocation regardless of repo. The project-specific file
  explicitly does not duplicate these — it only carries
  opencode-specific deltas.

The split avoids drift: global rules are authored once at
`~/.config/opencode/AGENTS.md`; project-specific rules live next to the
code they govern. `templates/AGENTS.md` is the deployment source for
the global file.

## Config management

### XDG layout

opencode follows XDG Base Directory spec via `Global.Path` in
`packages/opencode/src/global/index.ts`:

| Path | Source env | Purpose |
|---|---|---|
| `~/.config/opencode/` | `XDG_CONFIG_HOME` (`Global.Path.user` / `.config`) | **Primary runtime config** — accounts, models, MCP, providers, AGENTS.md |
| `~/.local/share/opencode/` | `XDG_DATA_HOME` (`Global.Path.data`) | Storage, snapshots, logs, opencode.db, bundled skills, **legacy `accounts.json`** |
| `~/.local/state/opencode/` | `XDG_STATE_HOME` (`Global.Path.state`) | Derived state — rebind checkpoints, frecency, prompt history, KV, rotation state, LKG snapshot |
| `~/.cache/opencode/` | `XDG_CACHE_HOME` (`Global.Path.cache`) | Disposable caches |

Both opencode (main) and opencode-beta share the same runtime dirs
because `const app = "opencode"` is hard-coded at the top of
`global/index.ts`. **Use `OPENCODE_DATA_HOME` to isolate beta** —
when set, all four paths nest under that root (`<root>/data`,
`<root>/cache`, `<root>/config`, `<root>/state`). `bun test`
auto-pins `OPENCODE_DATA_HOME` to a per-pid tmpdir under
`os.tmpdir()/opencode-test-<pid>` when `NODE_ENV=test` and no override
is set, **so tests never scribble on real `~/.config/opencode/`** —
this fix landed after the 2026-04-18 incident where
`family-normalization.test.ts` permanently lost 5 codex account tokens
from `accounts.json`.

### Files in `~/.config/opencode/`

| File | Role |
|---|---|
| `opencode.json` | **Boot-critical.** `$schema`, `plugin`, `permissionMode`. Post-Phase-3 split: < 500 bytes; `provider` and `mcp` no longer inline |
| `accounts.json` | Multi-account credential store (the file the runtime authoritatively reads; legacy `~/.local/share/opencode/accounts.json` is read on miss) |
| `mcp.json` | MCP server / app config; section-isolated (parse failure does not block daemon boot) |
| `mcp-auth.json` | OAuth tokens for MCP HTTP servers |
| `managed-apps.json` | Managed MCP app registry |
| `gauth.json` | Google OAuth state |
| `openai-codex-accounts.json` | OpenAI Codex account list |
| `models.json` | Per-account model overrides |
| `providers.json` | Provider override layer (replaces the manual `disabled_providers` field in `opencode.json`) |
| `AGENTS.md` | Global agent rules, deployed from `templates/AGENTS.md` |
| `prompts/`, `skills/` | Deployed prompt + skill content |

### `/etc/opencode/` — system-level

| File | Role |
|---|---|
| `opencode.cfg` | System defaults read by the gateway |
| `opencode.env` | systemd EnvironmentFile |
| `tweaks.cfg` | **Operator tunables** (see below) |
| `web_routes.conf` | Gateway route table written by `webctl.sh publish-route` |
| `google-bindings.json` | UID → Google account mapping for multi-user |
| `mcp-apps.json` | System-wide MCP app catalog |
| `webctl.sh` | Gateway control script (start / stop / publish-route) |
| `events/` | Gateway log surface |

### `tweaks.cfg` pattern

Hardcoded thresholds belong in `/etc/opencode/tweaks.cfg`, not in
source. Format: INI-style `key=value`, comments via `#` or `;`. The
`Tweaks` namespace at `packages/opencode/src/config/tweaks.ts` reads
once at module init via `loadEffective()`. Contract:

- Missing file → defaults + single `log.info` at startup
- Invalid value → `log.warn` + per-key default fallback (**not silent —
  AGENTS.md rule 1**)
- Unknown key → `log.warn` and skip
- `OPENCODE_TWEAKS_PATH` env var overrides path (used by tests)

Supported value forms: bool (`0`/`1`), int with min/max range, positive
number, ratio (`0.0–1.0`), comma-separated ratio list (must be strictly
ascending), pipe-delimited string list (`|` separator so phrases can
contain commas). Value-cross-key invariants are enforced (e.g.
`tail_window_kb` clamped to `<= part_inline_cap_kb` per INV-7;
`ui_freshness_threshold_sec < ui_freshness_hard_timeout_sec`;
`tool_output_budget_context_ratio` clamped to `<= 1`).

Active categories include: session read cache (TTL, max entries),
per-(user, method, route) rate limit, frontend session lazy-load
(part inline cap, tail window, fold preview lines, initial page size
buckets, mobile/desktop tail limits), tool output budget, compaction
pinned-zone token ratios, UI freshness gates.

### Config parse-failure defenses (Phase 1)

`Config.get()` flow when `~/.config/opencode/opencode.json` fails to
parse:

1. `loadFile(opencode.json)` throws `JsonError`
2. `log.warn` records "config parse failed — serving last-known-good
   snapshot" with offending path, line, column
3. Read `~/.local/state/opencode/config-lkg.json` (atomic-rename
   written on every successful load)
4. If LKG present → return `{ config: snapshot.config, configStale:
   true }` flag for downstream UI banners
5. If LKG missing → `log.warn` "no last-known-good snapshot available;
   propagating error", throw the (slimmed) `JsonError`
6. `server/app.ts` `onError` handler converts `ConfigJsonError` /
   `ConfigInvalidError` to **HTTP 503** (not 500) with body
   `{ code, path, line, column, hint }` — **never** `message` (which
   contains raw config text). Full debug snippet (±3 lines context)
   only goes to daemon `log.error`, never the response.
7. Webapp `/global/config` ErrorBoundary renders `code` / `path` /
   `line` / `hint` as structured fields — **never** as `innerText` of
   the response body.

### Provider availability derivation (Phase 2)

`providerAvailability(id)` returns one of `enabled` / `disabled` /
`no-account`:

1. Check `providers.json` override → `disabled` if user set it
2. Check `accounts.json` for any account on this provider → `enabled`
3. Else → `no-account` (treated as disabled, `log.info`)

Legacy `opencode.json.disabled_providers` is still read for one
release cycle, merged into the override layer; `log.info` suggests
running `scripts/migrate-disabled-providers.ts`. **Phase 2 does not
add a central filter point** — `provider.ts::initState` keeps its
existing per-source semantics (env / auth / account / plugin) so
edge-case providers that arrive via env or plugin without an account
are not accidentally hidden.

### Section-level isolation (Phase 3)

`state()` calls `loadSplit({ main, providers, mcp })`:

- `opencode.json` must succeed (or fall through to LKG) — boot-critical
- `providers.json` parse failure → empty override set + `log.warn`,
  daemon still serves
- `mcp.json` parse failure → MCP subsystem disabled + `log.warn`,
  main UI lives. MCP connections are lazy (first message triggers),
  so daemon boot does not need a working `mcp.json`.

The merged `Config.Info` shape is unchanged for callers; only the
on-disk layout and load path differ. Single-file `opencode.json` (with
inline `provider` / `mcp`) is still readable for one release cycle for
backward compatibility.

### AGENTS.md backup whitelist policy

Before any plan starts implementation phase (or `beta-workflow`
admission gate fires, or first code-edit / test command lands),
opencode mandates a snapshot of the **whitelist** of irreplaceable
config files — not the whole directory. From the project AGENTS.md:

```
~/.config/opencode/accounts.json                 (mandatory)
~/.config/opencode/opencode.json
~/.config/opencode/managed-apps.json
~/.config/opencode/gauth.json
~/.config/opencode/mcp.json
~/.config/opencode/mcp-auth.json
~/.config/opencode/openai-codex-accounts.json
~/.config/opencode/models.json
~/.config/opencode/providers.json
~/.config/opencode/AGENTS.md
~/.local/share/opencode/accounts.json            (legacy fallback)
```

Backup goes to `~/.config/opencode.bak-<YYYYMMDD-HHMM>-<plan-slug>/`,
preserving directory structure but holding only whitelist files.
**Restore is never automatic.** The user edits XDG in parallel with
plan execution; auto-restore would clobber legitimate concurrent
changes. Plan completion (success or abort) prints the backup path
and waits for the user to ask for restore. Every test / migration
path must respect this — `bun test` runs without an `accounts.json`
backup is treated as a violation.

Explicitly **not** backed up (cheap to regenerate or pure churn):
`node_modules/`, `bun.lock`, `daemon.lock`, `usage-stats.json`,
`*.bak*`, all of `~/.local/state/opencode/`, all of
`~/.local/share/opencode/log/` / `snapshot/` / `storage/`,
`opencode.db`, `running-tasks.json`.

### Environment variables

| Var | Effect |
|---|---|
| `OPENCODE_DATA_HOME` | Pin all four XDG paths under `<root>/{data,cache,config,state}`. Used by beta to avoid `~/.config/opencode/` collision and by `bun test` (auto-set when `NODE_ENV=test`) |
| `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` | Standard XDG overrides; `Global.Path` honours them |
| `OPENCODE_CONFIG` | Custom config file path; loaded with highest-but-one precedence (project config wins in non-test envs; project config is gated off in main builds) |
| `OPENCODE_TWEAKS_PATH` | Override `/etc/opencode/tweaks.cfg` path; primarily for tests |
| `NODE_ENV=test` | Auto-pins `OPENCODE_DATA_HOME` to a per-pid tmpdir if no explicit override |

### No silent fallback (AGENTS.md rule 1)

Every fallback path in the config subsystem logs explicitly:

- LKG used → `log.warn` with original failure location and LKG
  timestamp
- `mcp.json` failed → `log.warn` "mcp subsystem disabled"
- `providers.json` failed → `log.warn` "using empty override set"
- `disabled_providers` legacy read → `log.info` "consider migrating
  to providers.json"
- Tweaks file missing → `log.info` "using defaults"
- Tweaks key invalid → `log.warn` per key with raw value
- Project config gated off in main build → `log.debug` recording the
  gate

There is no path that swallows the error and continues with a default.
This is the behavioral contract that backs the AGENTS.md first-rule
prohibition on silent fallbacks.

## Code anchors

Plan-builder:
- `~/projects/skills/plan-builder/SKILL.md` — judgment surface
- `~/projects/skills/plan-builder/scripts/*.ts` — 10 stateful operations
- `~/projects/skills/plan-builder/schemas/state.schema.json` —
  `.state.json` machine contract
- `~/projects/skills/plan-builder/templates/` — required-artifact
  skeletons (`data-schema.json`, `test-vectors.json`, `errors.md`,
  `observability.md`, `invariants.md`, `ssdlc/*`)

Architecture documentation:
- `/home/pkcs12/projects/opencode/specs/architecture.md` — global index
- `/home/pkcs12/projects/opencode/specs/_archive/global-architecture/` —
  IDEF0 / GRAFCET reverse-engineering snapshot
- `/home/pkcs12/projects/opencode/AGENTS.md` — project-specific rules
- `~/.config/opencode/AGENTS.md` — global rules
  (deployed from `templates/AGENTS.md`)
- `/home/pkcs12/projects/opencode/docs/events/` — per-event change log

Config management:
- `packages/opencode/src/global/index.ts` — `Global.Path`, XDG
  resolution, `OPENCODE_DATA_HOME` fallback, test env pin
- `packages/opencode/src/config/config.ts` — `Config` namespace,
  `loadFile`, LKG snapshot read/write, `loadSplit` multi-file merge
  (`LKG_FILE = "config-lkg.json"` at L226; LKG read at L240, write at
  L255; multi-source precedence at L307+)
- `packages/opencode/src/config/tweaks.ts` — `Tweaks` namespace,
  per-type parsers with `log.warn` on invalid, cross-key invariants
- `packages/opencode/src/server/app.ts` `onError` — `ConfigJsonError`
  / `ConfigInvalidError` → HTTP 503 with structured body
- `packages/opencode/src/provider/availability.ts` — `providerAvailability`
  derivation
- `templates/` — XDG-deployed templates (`AGENTS.md`, `opencode.json`,
  `mcp.json`, `providers.json`, `models.json`, `prompts/`, `skills/`,
  `specs/`, etc.) — the deployment source for `~/.config/opencode/`

## Notes

### Migration of legacy spec packages

The three source packages (`specs/_archive/plan-builder/`,
`specs/_archive/global-architecture/`, `specs/_archive/config-management/`) remain on
disk. Per the on-touch peaceful migration policy, they will move to
`specs/_archive/` only when next touched by `plan-builder` scripts or
explicitly archived via `plan-archive.ts --move-to-archive-folder`.
The reader's primary entry point from now on is this `meta.md`.

### Why three concerns, one wiki entry

Plan-builder, architecture documentation, and config management are
all parts of opencode's **dev-time / meta layer** — none of them ship
as runtime features. They share the discipline that the user's local
state (config files, plan packages, architecture decisions) is the
authoritative source and that the system never silently overrides it.
Folding them together avoids three near-empty `*.md` entries that
each cross-link the others to explain the same backup-whitelist /
no-silent-fallback / `living`-state principles.

### Related entries

- [daemon/](../daemon/README.md) — daemon lifecycle, gateway ownership,
  `system-manager:restart_self`; sub-package
  [self-restart-handover/](../daemon/self-restart-handover/) is the
  durable handover checkpoint for restart orchestration.
- [mcp/](../mcp/README.md) — MCP subsystem; `mcp.json` parse-failure
  isolation in this entry's Phase 3 narrative.
- [account/](../account/README.md) — `accounts.json` schema, multi-account
  rotation; provider availability in this entry's Phase 2 narrative
  derives from it.
- [provider/](../provider/README.md) — `provider.ts::initState`, registry-first
  provider universe; consumes the availability API documented here.
  Per-provider detail under [provider/claude/](../provider/claude/README.md)
  and [provider/codex/](../provider/codex/README.md).
- [session/](../session/README.md) — runloop and how it consumes the merged
  `Config.Info`.
- [compaction/](../compaction/README.md) — for tunables flowing through
  `tweaks.cfg` (compaction pinned-zone token ratios, tool output
  budget); sub-package
  [working-cache/](../compaction/working-cache/) for L1+L2 cache.
- [harness/](../harness/README.md) — agent loop / runloop scaffolding
  (formerly `agent-runtime/`); in-flight
  [autonomous-opt-in/](../harness/autonomous-opt-in/) sub-package.
