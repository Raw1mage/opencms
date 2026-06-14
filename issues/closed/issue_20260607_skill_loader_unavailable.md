# Bug: `skill()` is not available as an on-demand callable despite skill-aware runtime contract

## Summary

The runtime/user instructions describe skills as on-demand capabilities that should be loadable with `skill(name="...")`, but the current exposed tool schema in this session does not provide a callable `skill()` tool. This prevents the agent from using skills such as `skill-finder` when the task explicitly requires skill discovery.

## Impact

- The agent cannot follow the documented skill-loading contract.
- On-demand skills mentioned in `AGENTS.md` become unreachable from the agent's actual tool surface.
- Tasks that require external capability discovery, such as using `skill-finder` to search for industrial-design skills, degrade into local registry/file searches.
- The agent may incorrectly appear unwilling or unable to use a skill even though the runtime policy says skills should be lazy-loadable.

## Observed Behavior

During a bodesign planning session, the user asked to use `skill-finder` for C01 industrial-design capability discovery. The agent could inspect local files and `enablement.json`, but no `skill()` callable was present in the available tool list. The only related callable was `tool_loader`, which loads tools, not skills, and cannot replace `SkillLayerRegistry` loading.

## Expected Behavior

One of the following should be true:

1. A `skill()` callable is always exposed when the prompt instructs the agent to load skills on demand.
2. `tool_loader` can explicitly load a `skill` loader tool when needed.
3. The prompt/tool contract clearly states that skills are preloaded only and cannot be requested at runtime.

The preferred behavior is option 1: expose `skill(name)` as a first-class lazy-loader whenever skill-aware instructions are active.

## Reproduction Notes

1. Start a session with skill-aware instructions that mention on-demand skills such as `skill-finder`.
2. Ask the agent to use `skill-finder`.
3. Inspect available tools: `skill()` is absent, while `tool_loader` is present.
4. The agent cannot invoke `skill(name="skill-finder")` and falls back to local file/registry search.

## Relevant Context

- Global instructions say skills must be loaded with `skill(name)` and reading `SKILL.md` is not equivalent.
- `AGENTS.md` lists `skill-finder` as on-demand.
- `enablement.json` lists bundled skills, but local inspection is not the same as runtime skill activation.

## Risk

This is a contract mismatch between prompt policy and tool availability. It can cause:

- false negatives in skill discovery,
- unnecessary manual workarounds,
- lower-quality task execution,
- user confusion when the agent says it cannot use a documented capability.

## Suggested Fix

- Ensure `skill()` is included in the tool schema whenever the session prompt includes skill-loading obligations.
- Add a regression test that starts a skill-aware session and verifies `skill(name)` is callable.
- If `skill()` is intentionally unavailable in some environments, update the prompt contract to avoid instructing agents to use it.

## Status

Resolved locally on 2026-06-07.

## Resolution

- Kept `skill` out of `ALWAYS_PRESENT_TOOLS` so normal turns do not pay full skill-loader schema/catalog context cost.
- Added lazy catalog priority for `skill`, ensuring it remains discoverable even when MCP/App tools exceed the 50-entry lazy catalog cap.
- This preserves on-demand behavior: the model can direct-call `skill`, letting lazy repair unlock it, or explicitly run `tool_loader({ tools: ["skill"] })` before `skill({ name: "..." })`.

## Verification

- `bun test packages/opencode/test/tool/tool-loader.test.ts` — 4 pass / 0 fail.
