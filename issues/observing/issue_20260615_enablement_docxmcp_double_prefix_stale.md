# BR: enablement.json still tells agents the double-prefix `mcpapp-docxmcp_docxmcp_*` key after toolID() canonicalized to single-prefix → tool_loader misses

Status: OBSERVING — root cause = bundled prompt advertised pre-canonicalization double-prefix `mcpapp-docxmcp_docxmcp_*` keys that `toolID()` (mcp/index.ts:918-929) collapses to single-prefix, so `tool_loader` missed the documented docxmcp call. Fixed across **all** surfaces (BR scoped only enablement.json; a full-repo sweep found a second site):
- `fdd5ef70e` — both enablement copies (`src/session/prompt/` + `templates/prompts/`) → single-prefix; new `enablement-tool-keys.test.ts` bans any duplicated `mcpapp-<app>_<app>_` prefix and ties docxmcp prefer keys to `MCP.toolID()`.
- `a6a0054ec` — `incoming/routing-hint.ts` background-status banner used the same stale double-prefix; fixed + `routing-hint.test.ts` hardened with `not.toContain`.
Deployed via `webctl.sh restart` (build-id `a6a0054ec-dirty`, ver `0.0.0-main-202606141647`). Verification: deployed binary has **0** `mcpapp-docxmcp_docxmcp_*` tool keys; guard + tool-id + routing-hint tests = 20 pass. Dead `~/.config/opencode/prompts/enablement.json` (9 stale occurrences, not runtime-loaded) **deleted** per user request.

Observing since: 2026-06-15 (post-deploy).
Exit → closed/: a real agent session loads `docxmcp_document` via tool_loader with no double-prefix miss, soak a few days with no recurrence.
Regress → open: any agent again told to call `mcpapp-docxmcp_docxmcp_*` (would mean a third un-swept surface or a re-introduced string the guard test didn't cover).

Original: root cause confirmed by code+prompt read (not hypothesis); fix is a prompt-text correction in the build-bundled enablement.json + opencode rebuild. Reported from a docxmcp-side investigation (see cross-ref).

## Symptom

The `enablement.json` capability registry instructs agents to call docxmcp tools by the **double-prefixed** key `mcpapp-docxmcp_docxmcp_<tool>`. But the live tool catalog exposes the **single-prefixed** `docxmcp_<tool>` (e.g. `docxmcp_document`). An agent that follows the enablement hint and calls `tool_loader(["mcpapp-docxmcp_docxmcp_document"])` loads nothing — the key does not exist. This is the tail of the 2026-05-21 namespace RCA (`docs/events/event_20260521_docxmcp-tool-namespace-rca.md` / the old `bug_20260521_docxmcp-tool-loader-not-injected`): the code was fixed, the prompt was not.

## Root cause (confirmed)

`toolID()` already canonicalizes away the duplicated prefix:

- `packages/opencode/src/mcp/index.ts:919-928` — when `clientName` starts with `mcpapp-` and the server tool name already starts with `<appId>_`, it returns the server tool name verbatim. For client `mcpapp-docxmcp` + tool `docxmcp_document` → returns **`docxmcp_document`** (single prefix). Covered by `packages/opencode/src/mcp/tool-id.test.ts`.

The **build-bundled** enablement prompt — imported statically at runtime by `packages/opencode/src/session/system.ts:21`, `.../session/llm.ts:46`, `.../session/resolve-tools.ts:26` — was only half-updated. Its docxmcp `tools` list was modernized to the unified surface (`docxmcp_document` / `docxmcp_stage`), but the **prefix guidance still describes the pre-canonicalization world** and directly contradicts `toolID()`:

- `packages/opencode/src/session/prompt/enablement.json`
  - L181 `key_prefix_note`: claims "runtime tool keys are `mcpapp-docxmcp_docxmcp_<tool>` (double prefix). Always reference the full key" — false since the 2026-05-21 fix.
  - L347 `prefer`: `["mcpapp-docxmcp_docxmcp_document", "mcpapp-docxmcp_docxmcp_stage", …]` — these keys do not exist in the catalog.
  - L354 `notes`: "ALWAYS prefer the MCP tool keys (`mcpapp-docxmcp_docxmcp_document`, `mcpapp-docxmcp_docxmcp_stage`)" — same.

## Evidence

| # | Reference | Shows |
|---|---|---|
| E1 | `src/mcp/index.ts:919-928` | toolID() strips the duplicate prefix → callable key is `docxmcp_document` (single) |
| E2 | `src/session/prompt/enablement.json:181,347,354` | enablement still instructs `mcpapp-docxmcp_docxmcp_*` (double) |
| E3 | `src/session/system.ts:21` / `llm.ts:46` / `resolve-tools.ts:26` | runtime loads enablement.json via static import from `src/session/prompt/` (this is the authoritative copy) |
| E4 | `templates/prompts/enablement.json` | same stale double-prefix (3 occurrences) — keep in sync |
| E5 | `~/.config/opencode/prompts/enablement.json` | even staler (9 occurrences, still lists deleted tools `docxmcp_extract_all` etc.) but NOT loaded by the runtime — dead file |

## Why it matters

- The enablement registry is the agent's authoritative "how to call this app" hint. A self-contradictory hint (correct tool names, wrong prefix) makes `tool_loader` fail on the documented call, so agents either give up on docxmcp or fall back to running the backend Python via bash — the exact failure mode the 2026-05-21 RCA set out to kill.
- Silent: nothing errors at build/load time; the agent just can't load the tool it was told to load.

## Fix

In the build-bundled copy `packages/opencode/src/session/prompt/enablement.json` (and the mirror `templates/prompts/enablement.json`):

1. `key_prefix_note` → state that opencode **removes** the duplicated prefix, so the runtime key is `docxmcp_<tool>` (single). e.g.: "docxmcp self-prefixes its tools `docxmcp_*`; opencode detects the duplicate App-Store prefix and exposes them as `docxmcp_<tool>` (NOT `mcpapp-docxmcp_docxmcp_*`). Call the single-prefix key."
2. `prefer` → `["docxmcp_document", "docxmcp_stage", "skill:doc-workflow"]`.
3. `notes` → replace the `mcpapp-docxmcp_docxmcp_*` references with `docxmcp_document` / `docxmcp_stage`.
4. Delete (or regenerate) the dead `~/.config/opencode/prompts/enablement.json` so it can't mislead anyone reading it manually.
5. Rebuild opencode — enablement.json is bundled at build time, so the prompt change only takes effect after a rebuild.

## Acceptance criteria

- enablement.json contains no `mcpapp-docxmcp_docxmcp_` substring; docxmcp keys are single-prefix everywhere (note + tools + prefer + notes).
- A guard test asserts every docxmcp `prefer` key equals `toolID("mcpapp-docxmcp", <serverToolName>)` — i.e. the prompt's advertised keys are derived from / validated against the real canonicalizer, so the two can never drift again. (Generalize: no `prefer` entry for an `mcpapp-` app may carry the duplicated prefix.)
- After rebuild, `tool_loader(["docxmcp_document"])` loads; the double-prefix key is absent from the catalog.

## Notes

- docxmcp side is correct — its tools are legitimately named `docxmcp_document` / `docxmcp_stage`; nothing to change there.
- Cross-ref: docxmcp repo BR `issues/20260614_pdf_decompose_source_resolution_and_token_workflow_issue.md` Q5 (this is the opencode-side resolution of that open question).
