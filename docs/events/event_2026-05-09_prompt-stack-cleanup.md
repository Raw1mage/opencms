# 2026-05-09 — System prompt stack cleanup

## Summary

Audited the runtime system prompt stack for logical consistency after diagnosing recurring AI self-paralysis ("跳針") in production sessions. Found that the bloated `tool/todowrite.txt` description (175 lines, Anthropic original cargo-cult) was at odds with the operator-side ledger discipline philosophy in `~/.config/opencode/prompts/SYSTEM.md`. Confirmed via session storage forensics that AI self-aborted on byte-equivalent tool calls (which were genuine model-side parallel-slot quirks, not runloop intervention) because of the conflicting threat language in SYSTEM.md §2.3.

Three rounds of cleanup landed:

1. **Tool descriptions** (commit `a8af12470` on main): slimmed `tool/todowrite.txt` 175→28 lines and `tool/todoread.txt` 14→11 lines to mechanism-only. Removed all "use proactively" / "VERY frequently" / "When in doubt use this" cargo-cult and the 4 inline examples. Added a footer explicitly pointing at SYSTEM.md / agent prompts for behavior policy.

2. **`~/.config/opencode/prompts/SYSTEM.md`** (XDG override, not in git): 290→245 lines.
   - Deleted §2.5 Planning-First Flow (abstract; plan-builder enforcement lives in AGENTS.md "開發任務預設工作流").
   - Deleted §2.7 Execution Modes (no such mode in actual runtime).
   - Deleted §9 Autorun (autonomous continuation is hardcoded into runloop; prompt control redundant).
   - Deleted §2.3 line 77 anti-rewrite "will be terminated" threat (paralysis detector empirically does not fire on within-turn byte-equivalent calls; threat caused false self-aborts).
   - Reworded §4 #7 to clarify that the prohibition is on `<thinking>` tags / chain-of-thought in user-visible text, NOT the provider reasoning channel which §10 explicitly uses for cache-digest emission.
   - Rewrote §13 Presentation Defaults → §12 Output Discipline: "mention only what the user can't already see in UI". Skip diff / tool result / todo recap; surface only cognitive conclusions, error reasons, and next-step hints. Default posture is silent stop; one-liner only when there's UI-invisible insight.
   - Renumbered sections after deletions.
   - Backup at `~/.config/opencode/prompts/SYSTEM.md.bak-20260509-prompt-stack-cleanup`.

3. **Audit findings the user explicitly preserved**:
   - AGENTS.md (`~/.config/opencode/AGENTS.md`) "開發任務預設工作流" rule "**必須**先透過 plan-builder skill" stays. plan-builder is a concrete skill (not abstract "plan mode"), and the enforcement is meaningful.
   - Working Cache emission etiquette in SYSTEM.md §10 unchanged. CoT精簡靜默 + post-toolcall conclusions to reasoning channel matches existing rule.
   - Subagent layer (input.agent.prompt) preserved. L2 layer is the dispatch-time capability injection point for child processes (coding.txt / explore.txt / etc.). Main agent's L2 is naturally empty (no `build` agent prompt file) — implementation already aligns with intent.

## Bundled `claude.txt` left intact

The bundled `packages/opencode/src/session/prompt/claude.txt` (121 lines, Anthropic original with `TodoWrite VERY frequently / unacceptable` plus duplicated tone/style/tool-usage rules) is shadowed on this machine by the XDG override at `~/.config/opencode/prompts/drivers/claude.txt` (32 lines, persona-only, "TheSmartAI"). Audit attention spent on the bundled version was misdirected — the XDG override is what actually loads.

Future-proofing for new machines (where bundled would seed): the bundled `claude.txt` should be slimmed to match the XDG persona-only discipline. Not done in this commit; tracked as a follow-up.

## Why this was hard to find

The `loadPrompt()` indirection in `packages/opencode/src/session/system.ts` reads from `~/.config/opencode/prompts/<filename>` first, falling back to the bundled `import` only if XDG file is absent. New machines get bundled; this user's machine has overrides. Static-analysis grep on the source repo shows the bundled content but not what's actually injected into the LLM request. Diagnosis required diffing bundled vs XDG to see where the rules actually live.

## Net effect

The prompt stack now has:

- ONE place for "when to call todowrite" rules: SYSTEM.md §2.5 Todo Authority + §2.3 Dispatch Rules.
- ONE place for plan flow enforcement: AGENTS.md `開發任務預設工作流`.
- ONE place for output discipline: SYSTEM.md §12 (UI-invisible conclusions only).
- ZERO redundant frequency/proactiveness encouragement in tool descriptions.
- ZERO "will be terminated" bluffs that the runtime doesn't actually back.

Expected behavior change: AI no longer self-aborts on within-turn byte-equivalent tool calls. Idempotent duplicates (todowrite same id same status, repeated question popup) are tolerated as harmless waste rather than alarm-worthy paralysis.

## Verification

Wait for the next time the user sees a session in production and observe whether the "持續發生小跳針" pattern recurs. Live test happens organically — no synthetic repro because the bug is a model-behavior tendency, not a deterministic code path.

## Files touched

- `packages/opencode/src/tool/todowrite.txt` (commit `a8af12470`)
- `packages/opencode/src/tool/todoread.txt` (commit `a8af12470`)
- `~/.config/opencode/prompts/SYSTEM.md` (XDG, not in git)
- `docs/events/event_2026-05-09_prompt-stack-cleanup.md` (this file)
