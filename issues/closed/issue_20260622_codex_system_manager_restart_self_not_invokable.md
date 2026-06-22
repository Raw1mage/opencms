# BR: Codex tool surface cannot invoke `system-manager_restart_self` even though loader reports it callable

Status: RESOLVED (2026-06-22) — same root cause as the sibling `rename_session` BR: NOT a wire/tool-surface gap, but misleading prompt framing. Fixed by the same global, provider-agnostic prompt-text change (`<deferred-tools>` → `<on-demand-tools>` + "missing from function list ≠ unavailable"). See RESOLUTION below.

---

## RESOLUTION / corrected RCA (2026-06-22)

The "suspected failure modes" below are **wrong** for the same reason BR `issue_20260622_system_manager_rename_session_deferred_tool_not_invokable.md` was wrong. The fix for that BR is global and provider-agnostic, so it covers `restart_self` too. Verified end-to-end:

- **Fix is on main + live.** Commit `947105d23` ("fix(session): rename deferred-tools → on-demand-tools + session_status drift poll") is current HEAD; `tool-loader.ts` / `invalid.ts` / `prompt.ts` all emit `<on-demand-tools>` with explicit text: "A missing entry in your tool list does NOT mean the tool is unavailable." Live daemon binary rebuilt 2026-06-22 09:56, after the commit.
- **Repair hook is name-agnostic + provider-agnostic.** `session/llm.ts:2245` `experimental_repairToolCall` checks `input.lazyTools.has(toolName)` for ANY failed tool name, unlocks it, injects the schema, and passes the call through. It does not special-case Claude vs Codex.
- **Codex wire path does not filter tool names.** `provider-codex/src/sse.ts:447-484` surfaces a `tool-call` for whatever `item.name` the Responses server returns — no filtering against `body.tools` — so an off-wire name reaches `streamText`, misses `tools`, and fires the repair hook. The OpenAI Responses server does emit `function_call` for prompt-only names.
- **Logs prove real Codex unlocks.** `~/.local/share/opencode/log/debug.log*` show `auto-unlocked lazy tool` for `system-manager_restart_self` (×2), `system-manager_rename_session` (×7), plus Codex-driven `docxmcp_pptx_edit` (×79), `write` (×52), `edit` (×59) — confirming off-wire unlock works on Codex, not just Claude.
- **Live activation confirmed in a Claude session**: `system-manager_get_session` (absent from the function list) called directly → auto-loaded and returned canonical metadata.

So the original "Codex compatibility adapter cannot emit absent tool names" hypothesis is disproved: the BR session caught the same framing-variance losing roll that the `rename_session` BR did. The prompt-text fix (global) resolves both.

### Residual (separate, NOT a tool-surface issue)

The warroom validation note (`up{job="opencode-runtime"}=0`, `:9105` no listener) is blocked on the gateway env-forward patch (`daemon/opencode-gateway.c` forwarding `OPENCODE_METRICS_PORT`) taking effect after a sanctioned gateway restart — an independent ops follow-up, tracked under the warroom/observability work, not this tool-surface BR.

---

### Original report (superseded by the RCA above)

Status: OPEN — reproduced during warroom/opencms observability implementation; blocks sanctioned gateway restart.

Date: 2026-06-22
Scope: opencode Codex compatibility tool bridge / Active Loader / system-manager direct tool surface
Severity: high

## Summary

During the warroom dashboard work, the agent needed to restart the opencode gateway through the sanctioned lifecycle path:

```text
system-manager_restart_self targets:["gateway"]
```

This was required because the task changed `daemon/opencode-gateway.c` and the project rules explicitly forbid restarting/killing/spawning the daemon or gateway via bash. The agent attempted to load/discover `system-manager_restart_self` via `tool_loader`, and the loader reported that it was directly callable, but the Codex tool schema exposed to the agent did not include any callable `system-manager_restart_self` recipient. The agent therefore could not perform the approved restart and had to ask the user to trigger it externally.

This is a Codex/tool-bridge capability mismatch: the lazy-tool catalog says the tool is available, but the provider-facing tool schema prevents the model from emitting the direct call.

## User impact

- Blocks sanctioned daemon/gateway lifecycle operations from Codex sessions.
- Forces the agent into an impossible choice: violate lifecycle rules with bash, or stop and ask the user to restart manually.
- Breaks end-to-end implementation workflows where code/config changes require `restart_self` before validation.
- Creates contradictory UX: `tool_loader` says `system-manager_restart_self` is callable, but the actual tool surface has no callable handle.

## Observed transcript evidence

In a live warroom/opencms observability session:

1. Agent added opencode runtime Prometheus exporter wiring and warroom dashboards.
2. Verification showed Prometheus target existed but `up{job="opencode-runtime"}=0` because `127.0.0.1:9105` was not listening.
3. Root cause was that `OPENCODE_METRICS_PORT` needed to be forwarded by the gateway-spawned daemon environment. Agent patched:
   - `daemon/opencode-gateway.c` — forwards `OPENCODE_METRICS_PORT` to the per-user daemon.
4. Applying that patch required a sanctioned gateway restart, not bash/systemctl.
5. Agent called:

```json
tool_loader({"tools":["system-manager_restart_self"]})
```

and later:

```json
tool_loader({"tools":["system-manager"]})
```

6. Loader response said, in part:

```text
These tools are already directly callable — invoke ... system-manager_restart_self ... now with real arguments.
Resolved alias system-manager → ... system-manager_restart_self ...
```

7. The actual available Codex tool schema did not expose `system-manager_restart_self`; the model could not emit the required tool call.
8. The agent refused to use bash `systemctl restart` / kill / spawn because that violates the opencode daemon lifecycle contract.

## Expected behavior

One of these must be true:

1. **Direct callable exposed:** `system-manager_restart_self` appears as an invokable function in Codex sessions when the lazy-tool catalog reports it as directly callable.
2. **Repair path works for absent direct tools:** the model can emit `system-manager_restart_self` despite it being absent from the visible schema, and `experimental_repairToolCall` resolves it before provider/tool-bridge rejection.
3. **Always-present wrapper exists:** a stable exposed wrapper supports restart operations, for example `system-manager_manage_session` or a generic `system-manager_execute_command` action that routes to restart_self without bash/systemctl.
4. **Fail-fast honest loader output:** if Codex compatibility mode cannot invoke the direct system-manager tools, `tool_loader` must say discovered-but-not-invokable and name the correct available alternative.

## Actual behavior

- `tool_loader` reported `system-manager_restart_self` as directly callable.
- No corresponding callable existed in the Codex tool schema.
- The agent could not complete the sanctioned restart despite explicit user approval.
- Work remained partially validated: dashboards/provisioning were ready, but runtime exporter validation was blocked at `up=0` until an external gateway restart occurs.

## Related issues

- `issues/issue_20260622_system_manager_rename_session_deferred_tool_not_invokable.md`
  - Same class of defect, but for `system-manager_rename_session` in close-out flow.
- `issues/closed/issue_20260617_tool_loader_loaded_tool_not_callable.md`
  - Closed after making loader messaging honest under Active Loader. This BR shows the remaining Codex compatibility gap for high-impact lifecycle tools.

## Suspected failure modes

- Codex CLI compatibility adapter only exposes the static core tools and does not dynamically expose deferred `system-manager_*` direct tools as provider-callable schemas.
- The repair/autoload path may depend on the model emitting an absent tool name, but Codex's wrapper rejects or hides absent tool calls before opencode's repair hook can act.
- `tool_loader` reads the canonical enablement/lazy catalog, but does not account for provider-specific tool-call emission constraints.
- System-manager direct tools may exist in opencode native sessions but not in the Codex compatibility namespace.

## Acceptance criteria

1. In a Codex-backed main-agent session, ask the agent to run a sanctioned restart:

```text
system-manager_restart_self targets:["gateway"]
```

2. Agent can invoke a real toolcall, not bash/systemctl/kill/spawn, and receives a restart txid/result.
3. `tool_loader({"tools":["system-manager"]})` only says "invoke directly" if the Codex tool bridge can actually accept those direct calls.
4. If direct calls are impossible in Codex mode, the loader output includes the correct reachable fallback.
5. Regression test covers alias discovery (`system-manager`) plus direct invocation of `system-manager_restart_self` from the exact tool surface delivered to Codex sessions.

## Suggested fix directions

- Add a Codex compatibility invariant: every tool name that `tool_loader` says "invoke now" must be accepted by the provider-facing tool schema or repairable before provider rejection.
- Expose a small always-present `system-manager_restart_self` shim in Codex sessions, at least for sanctioned lifecycle operations.
- Alternatively expose a generic always-present `system-manager_manage_session` / `system-manager_app_control` wrapper that includes `restart_self` semantics.
- Make loader output provider-aware: distinguish `discovered`, `lazy-callable`, `wire-callable`, and `not invokable in this driver`.

## Validation notes from the blocked session

- Warroom dashboards were provisioned successfully:
  - `opencms-access-audit`
  - `opencms-runtime-performance`
  - `opencms-app-logs`
- Prometheus target existed:

```promql
up{job="opencode-runtime"} == 0
```

- Host listener was absent:

```text
ss -ltn sport = :9105
# no listener
```

- The remaining required operation was only the sanctioned gateway restart; no code fallback was appropriate.
