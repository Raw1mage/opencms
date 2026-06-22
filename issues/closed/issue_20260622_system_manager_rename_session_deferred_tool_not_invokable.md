# BR: `system-manager_rename_session` appears in lazy-tool catalog but is not invokable from the agent tool surface

Status: RESOLVED (2026-06-22) — root cause was NOT a wire/tool-surface gap; it was misleading prompt framing. Fixed by renaming the model-facing `<deferred-tools>` catalog to `<on-demand-tools>` and adding text that explicitly counters the "not in my function list ⇒ uncallable" prior. See RESOLUTION below.

---

## RESOLUTION / corrected RCA (2026-06-22)

The original "suspected failure modes" below are **wrong**. On-demand (lazy) tools **do** work on Codex. Proof from `~/.local/share/opencode/log`: codex/gpt-5.5 sessions auto-unlocked off-wire lazy tools **20 times** (`docxmcp_pptx_edit`, `docxmcp_document`, `write`, `edit`, …) via `experimental_repairToolCall`.

Mechanics confirmed in code:
- `provider-codex/src/sse.ts` surfaces a `tool-call` for **whatever name the server returns** (`item.name`) — no filtering against `body.tools`. So a `function_call` for an off-wire name reaches `streamText`, misses `tools`, fires `experimental_repairToolCall` (`session/llm.ts`), which unlocks + runs it. Identical to the Claude path, minus the ANTML salvage step. The OpenAI Responses server **does** emit `function_call` for names described only in the prompt.

Why the BR session still failed: **framing variance.** The catalog was tagged `<deferred-tools>` and `tool_loader`'s description called them "deferred tools". "Deferred" connotes "postponed / not yet active", which fights the body text ("call directly") and nudges the model to (a) detour through `tool_loader`, then (b) on the "already callable — no-op" reply, conclude "there is no callable handle" and give up — instead of just emitting the call. Other turns picked the direct path and succeeded; the BR caught a losing roll of that variance.

Fix (prompt-text only, no wire/mechanism change):
- `<deferred-tools>` → `<on-demand-tools>` everywhere model-facing (`tool/tool-loader.ts` catalog + `tool_loader` description, `tool/invalid.ts` sink, `session/prompt.ts` perseveration message).
- Catalog header now states explicitly: a missing entry in the function list does NOT mean the tool is unavailable; call it by name and the runtime auto-loads it.
- `session/claude-import.ts` keeps the old `deferred-tools`/`deferred_tools` tags in the preface strip-list for back-compat with stored transcripts.
- Takes effect after a daemon rebuild+restart (sanctioned `system-manager:restart_self`).

---

### Original report (superseded by the RCA above)

Status: OPEN — reproduced in a live session close-out flow; needs runtime/tool-surface triage.

Date: 2026-06-22
Scope: opencode tool exposure / Active Loader / system-manager direct tool surface
Severity: medium-high

## Summary

User asked the agent to close out the session by renaming the current session title with a `[✓]` prefix. The agent attempted the documented route:

1. `tool_loader({"tools":["system-manager"]})`
2. loader response listed `system-manager_rename_session` as directly callable
3. agent attempted to continue, but no `system-manager_rename_session` function handle existed in the available tool namespace
4. agent could not perform the rename and had to ask the user to file this BR

This is a regression / unresolved edge of the prior tool-loader and session-rename work: the loader message now says tools are directly callable, but this particular environment did not expose the direct callable to the agent schema, and the auto-load-on-first-use path could not be exercised because the model cannot emit a tool call to a function handle that is absent from the tool list.

## User impact

- Breaks the documented session completion convention: add `[✓]` to the session title when all work is done.
- Forces the agent to admit it cannot complete a simple tool-driven close-out action.
- Creates contradictory UX: runtime says `system-manager_rename_session` is callable, but the actual agent interface has no callable handle.
- Reopens trust issues around lazy tools: users see “打勾” as a lightweight action, but the agent stalls on tool plumbing.

## Observed transcript evidence

In a completed PPTX/docxmcp BR session, the user requested:

```text
用skill rename session 打勾
```

The agent called:

```json
tool_loader({"tools":["system-manager"]})
```

The loader response said, in part:

```text
These tools are already directly callable — invoke ... system-manager_rename_session ... now with real arguments.
Resolved alias system-manager → ... system-manager_rename_session ...
```

But the available function tools in the agent runtime did not include a `system-manager_rename_session` recipient. The agent only had the standard tool list (`bash`, `read`, `glob`, `grep`, `apply_patch`, etc.) plus `tool_loader`, not direct `system-manager_*` function handles. The agent therefore could not issue the actual rename call.

## Expected behavior

One of these must be true:

1. **Direct callable exposed:** after tool discovery or by default, `system-manager_rename_session` is present as an invokable function in the agent tool schema.
2. **Auto-load repair works for absent direct tools:** the agent can emit a call to `system-manager_rename_session` even when not listed, and `experimental_repairToolCall` resolves it from `lazyTools`.
3. **Fallback callable exists:** a stable always-present wrapper such as `system-manager_manage_session` is exposed and supports `operation=rename` for the current serving session.
4. **Fail-fast honest message:** if none of the above is available in the current driver/tool bridge, `tool_loader` must say the tool is discovered but not invokable in this environment, and provide the correct alternative.

## Actual behavior

- `tool_loader` listed `system-manager_rename_session` as directly callable.
- No corresponding callable existed in the visible tool schema.
- The agent could not rename the session.

## Related prior issues

- `issues/observing/issue_20260615_session_rename_tool_inconsistent_current_cache.md`
  - Added / validated `rename_session` semantics and canonical readback.
  - This new BR is not about wrong session target or cache disagreement; it is about the direct tool not being invokable at all from this agent surface.
- `issues/closed/issue_20260617_tool_loader_loaded_tool_not_callable.md`
  - Resolved misleading “available next action” messaging under Active Loader.
  - This new BR shows the “call them directly now” contract still fails when the callable is absent from the provider-facing tool schema and cannot be emitted.

## Suspected failure modes

- The driver/tool bridge shown to this agent does not include deferred `system-manager_*` direct tools, despite the lazy-tool catalog resolving them.
- `tool_loader` can list tools from enablement/lazy catalog even when the current provider/tool bridge cannot accept calls to absent tool names.
- The auto-repair path may require the model to emit an unavailable tool call, but some wrappers reject/omit such calls before repair can run.
- `system-manager_rename_session` may be available in opencode’s native runtime but not in this Codex CLI compatibility tool namespace.

## Acceptance criteria

1. In a normal main-agent session, ask the agent to rename the current session with `[✓]...`.
2. Agent can call a real tool, not bash/CLI workaround, to rename the current serving session.
3. Tool result returns canonical post-write title and session ID.
4. If direct `system-manager_rename_session` cannot be exposed in a driver, the loader response names the correct invokable wrapper for that driver.
5. Regression test covers alias discovery (`system-manager`) and direct invocation of `system-manager_rename_session` from the same tool surface the agent actually receives.

## Suggested fix directions

- Add a tool-surface invariant test: every tool name that `tool_loader` says “invoke now” must be invokable in that driver or repairable before provider rejection.
- For compatibility drivers that cannot emit absent lazy tool names, expose a small always-present `system-manager_manage_session` / `system-manager_rename_session` shim.
- Include `current session rename` in end-to-end close-out tests because it is a high-frequency workflow convention (`[✓]` session title prefix).
