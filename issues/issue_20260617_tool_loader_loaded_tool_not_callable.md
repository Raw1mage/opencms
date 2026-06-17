# BR: tool_loader reports tool loaded but callable is unavailable

Date: 2026-06-17
Scope: opencode tool loading / runtime tool schema exposure
Status: RESOLVED (2026-06-17) — root cause was NOT a broken unlock; it was `tool_loader`'s misleading success message under the Active Loader (DD-21) architecture. Fixed by making the message honest + repositioning the tool as a compatibility shim. See "Root Cause" + "Resolution" below.
Severity: high

## Summary

`tool_loader` can report that a tool was successfully loaded, but the loaded tool does not become callable in the assistant's next action. This breaks user-visible workflows that depend on lazy-loaded MCP tools, such as marking a completed session with `system-manager_rename_session`.

## Reproduction

1. User asks the assistant to mark the session as completed.
2. Assistant calls:
   - `tool_loader({"tools":["system-manager"]})`
   - Runtime reports `Loaded tools: ... system-manager_rename_session ... They are available on your next action.`
3. Assistant still cannot call `system-manager_rename_session` because no corresponding callable appears in the available tool schema.
4. User asks to try explicitly.
5. Assistant calls:
   - `tool_loader({"tools":["system-manager_rename_session"]})`
   - Runtime reports `Loaded tools: system-manager_rename_session. They are available on your next action.`
6. On the next action, the callable is still unavailable to the assistant.

## Expected

When `tool_loader` reports a tool as loaded and available on the next action, that tool must appear as an invokable callable in the next tool schema, or the loader must fail loudly with a precise reason.

## Actual

The loader reports success, but the assistant cannot invoke the tool. The assistant is forced to tell the user that the operation cannot be completed, even though the runtime claimed the tool was loaded.

## Impact

- Breaks completion workflow: the agent cannot call `system-manager_rename_session` to add the `[✓]` prefix.
- Creates contradictory user experience: "Loaded" is reported, but the operation is impossible.
- Undermines lazy-loader contract and MCP/tool discoverability.

## Acceptance Criteria

- Lazy-loaded direct tools are exposed as callable schemas on the next assistant action.
- If a direct tool cannot be exposed, `tool_loader` returns a failure or partial-success status with a reason.
- Add a regression test covering explicit direct-tool load, e.g. `system-manager_rename_session`, and alias load, e.g. `system-manager`.

## Evidence

Observed in session while trying to complete a task:

- Alias load reported `system-manager_rename_session` among loaded tools.
- Explicit load reported `Loaded tools: system-manager_rename_session`.
- No callable became available afterward.

## Root Cause (confirmed 2026-06-17)

The premise behind the BR ("the loaded tool should appear as a callable on the
next action") is **incompatible with the current Active Loader architecture
(DD-21)** — and `tool_loader`'s success message contradicted that architecture,
which is the actual defect.

Causal chain:

1. `tool_loader.execute()` calls `UnlockedTools.unlock(sessionID, found)`
   (`packages/opencode/src/tool/tool-loader.ts`), adding the names to
   `unlockedBySession`.
2. The next turn's `resolveTools()` **deliberately ignores that set**.
   `packages/opencode/src/session/resolve-tools.ts:458-475` strips every
   non-`ALWAYS_PRESENT` tool out of the wire `tools[]` and pushes it into
   `lazyTools`, with an explicit comment: _"lazy tools are NEVER promoted into
   the wire tools[]. A previously 'unlocked' tool is intentionally NOT re-added
   here — the old `&& !unlocked.has(id)` clause grew the wire prefix on every
   first use and cold-missed the ENTIRE cache."_ The `unlocked` set is read at
   line 440 and then never used. So `unlock()` is a **no-op** for callability.
3. The real load path is **direct call + `experimental_repairToolCall`**
   (`packages/opencode/src/session/llm.ts:2219-2278`): when the model emits a
   call to a tool present in `input.lazyTools`, the repair hook auto-unlocks it,
   registers its full schema, and executes the original call the **same turn**.
   The `<deferred-tools>` manifest itself states: _"You can call any of them
   directly — they will be auto-loaded on first use. No need to call
   tool_loader first."_

So `system-manager_rename_session` was always directly callable. The reporter
went through `tool_loader`, whose `"Loaded tools: … available on your next
action"` message was a stale lie from the pre-Active-Loader era — it implied a
wire-schema promotion that the architecture intentionally no longer performs.

## Resolution (2026-06-17)

Chose option (A) — make `tool_loader` honest + reposition it as a compatibility
shim. No attempt to re-promote unlocked tools into the wire set (that is exactly
what DD-21 removed for prompt-cache stability; reintroducing it would cold-miss
the whole cached prefix every first use).

Changes (`packages/opencode/src/tool/tool-loader.ts`):

- Extracted the result messaging into a pure, ctx-free `formatLoaderOutput()`
  so the contract is regression-testable.
- Success line changed from `"Loaded tools: X. They are available on your next
action."` to `"These tools are available — call them directly now: X. No
tool_loader round-trip is needed; deferred tools auto-load on first use."`
- Title changed from `"Loaded N tool(s)"` to `"N tool(s) ready"`.
- `TOOL_LOADER_STATIC_DESCRIPTION` rewritten to describe the tool as a
  compatibility shim that does NOT gate callability (kept STATIC per DD-21 so it
  never churns the cached tools→system prefix).
- `execute()` now delegates output to `formatLoaderOutput()`; the `unlock()`
  call is retained (harmless, keeps `getAvailable` snapshots consistent) but is
  no longer described as the thing that makes a tool callable.

Regression tests added (`packages/opencode/test/tool/tool-loader.test.ts`,
`describe("tool-loader honest output (issue_20260617)")`):

- direct-tool load asserts the output contains `"call them directly now"` and
  does NOT contain `"available on your next action"` / `"Loaded tools"`.
- alias load (`system-manager`) asserts resolution + honest wording.
- all-not-found asserts the failure title + error guidance.

Validation: `bun test packages/opencode/test/tool/tool-loader.test.ts` → 7 pass.
`bun run --cwd packages/opencode typecheck` → no tool-loader errors.
