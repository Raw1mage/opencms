# Event: Skill Registry Seam Closure

**Date:** 2026-04-19
**Scope:** Close the seam between "AI is told to load a skill" (semantic) and "skill enters `SkillLayerRegistry`" (mechanical). Also roll out `planner` → `plan-builder` naming migration.

## Motivation

Investigation started from a sidebar complaint: the **已載技能 / Loaded Skills** card showed `No managed skills.` in sessions where the user semantically asked the AI to work with a skill (e.g. `plan-builder`). Telemetry confirmed the registry was genuinely empty:

- `bus.llm.prompt.telemetry` consistently reports `skill_layer_registry` block with `chars:0, injected:false, policy:"registry_seam_empty"`.
- Storage scan across all historical sessions: **zero** `"tool":"skill"` invocations recorded.
- System prompts used mechanism-neutral phrasing (`"load the planner skill"`, `"Both skills MUST be loaded"`) that let the AI satisfy the instruction by reading `SKILL.md` via the `read` tool or by inferring intent from the catalog description in the `skill` tool schema — both bypass `SkillLayerRegistry`.

Consequence: dynamic-context-layer's token management (pin / summarize / idle-unload) was architecturally gated on the registry, which stayed permanently empty. Skill content that was *effectively loaded* (via `read` on `SKILL.md`, or via direct ingestion of the catalog description) occupied tokens but was invisible and unmanaged.

## Change Summary

### 1. SYSTEM.md Hardening (the rule layer)

`templates/prompts/SYSTEM.md` + `~/.config/opencode/prompts/SYSTEM.md`:

- **§ 2.4** added a negative rule: `skill()` is the only supported load path; `read` on `SKILL.md` is reserved for skill development/review, not for *using* the skill.
- **§ 2.5** restated the mechanism explicitly ("call `skill({name: "<name>"})` as your first tool calls in plan mode") and noted that reading `SKILL.md` does not count as loading.

### 2. Read Interceptor (the safety-net layer)

`packages/opencode/src/tool/read.ts`:

- When a normal text-file read resolves to a `SKILL.md` basename, append a short `<skill_advisory>` block to the output:

  ```
  <skill_advisory>
  Reading of SKILL.md is detected.
  If you intend to load a skill, use skill() instead, else just go ahead.
  </skill_advisory>
  ```

- Non-blocking, content unchanged. Lets the AI self-classify intent: USE → abort and call `skill()`; DEVELOP → continue freely.
- Does not auto-register the skill in `SkillLayerRegistry` (to avoid interfering with dev-mode edits being summarized/unloaded mid-work).

Tests added in `packages/opencode/test/tool/read.test.ts` verify advisory appears for `SKILL.md` and does not appear for other markdown files.

### 3. planner → plan-builder Rename Sweep

`planner` has been deprecated by `plan-builder` per the 2026-04-18 skill launch. Remaining prompt-layer references were cleaned up:

**Source prompts (build-time imported):**
- `packages/opencode/src/session/prompt/plan.txt`
- `packages/opencode/src/session/prompt/plan-reminder-anthropic.txt`
- `packages/opencode/src/session/prompt/claude.txt`
- `packages/opencode/src/session/prompt/runner.txt`

**Template mirrors (seeded at first run or release):**
- `templates/prompts/SYSTEM.md`
- `templates/prompts/session/plan.txt` (re-synced from source)
- `templates/prompts/agents/planner.txt` → renamed to `plan-builder.txt` (content also updated)
- `templates/AGENTS.md`
- `templates/system_prompt.md`
- `templates/global_constitution.md`
- `templates/specs/handoff.md`
- `templates/specs/spec.md`
- `templates/specs/tasks.md`
- `templates/skills/agent-workflow/SKILL.md`

**Runtime mirrors (to take effect immediately on this machine):**
- `~/.config/opencode/prompts/SYSTEM.md`
- `~/.config/opencode/prompts/session/plan.txt`
- `~/.config/opencode/prompts/agents/plan-builder.txt` (planner.txt removed)
- `~/.config/opencode/AGENTS.md`

**Deliberately NOT touched:**
- `templates/skills/planner/` — still marked DEPRECATED; kept for legacy `/plans/` package compatibility per the 2026-04-18 launch note.
- `templates/skills/plan-builder/SKILL.md` — already references "legacy `planner` skill" intentionally as historical context.
- `templates/system/opencode.cfg` — `OPENCODE_PLANNER_TEMPLATE_DIR` env var kept to avoid breaking external installations and the referencing script in `templates/skills/planner/scripts/plan-init.ts`. Rename can be handled in a separate targeted cleanup.
- `.git/` log history.

## Verification

- `bun test test/tool/read.test.ts` → 33 pass / 1 skip / 0 fail (includes 2 new advisory tests).
- Full `bun run typecheck` shows only pre-existing errors; `read.ts` clean.
- `grep -rnE "\bplanner\b"` on in-scope files returns zero matches (after excluding deprecated skill dir, plan-builder's own description, env var, and git logs).

## Expected Runtime Impact

After this patch, AI behavior should converge to:

1. Reading `SKILL.md` immediately surfaces a soft notice, creating prompt pressure toward `skill()` on subsequent turns.
2. New prompt rules in SYSTEM.md ban the `read SKILL.md` path for *using* a skill.
3. Over time, `SkillLayerRegistry` becomes non-empty; sidebar's **已載技能** card becomes a true reflection of session state; dynamic-context-layer's pin / summarize / idle-unload actually has content to manage.

## Remaining Follow-ups (not in this patch)

- Consider auto-registering reads in dev mode IF a subsequent `edit`/`write` lands in the same skill dir, to opt-out of the advisory retroactively. Not MVP.
- Telemetry: add a counter for `SKILL.md reads that weren't followed by skill() calls`, to quantify habit change.
- ENV var rename `OPENCODE_PLANNER_TEMPLATE_DIR` → `OPENCODE_PLAN_BUILDER_TEMPLATE_DIR` with backward-compatible fallback.
