# Errors: mandatory-skills-preload

Every runtime error / warning surface introduced by this spec. Code / message / recovery strategy / responsible layer.

## ERR_MANDATORY_SENTINEL_MALFORMED

- **Trigger**: `parseMandatorySkills(text)` encounters a `<!-- opencode:mandatory-skills -->` opener with no closing tag before EOF, or nested opener, or malformed markdown.
- **User-visible message**: `[mandatory-skills] malformed sentinel block in <path> at line <N>; treating as empty`
- **Layer**: Parser (`packages/opencode/src/session/mandatory-skills.ts`)
- **Log level**: `warn`
- **Recovery**: Return the skills collected so far (possibly empty); do NOT throw; emit anomaly event `skill.mandatory_parse_warn` with path + line.
- **Rationale**: Parser is called every round; throwing would cascade into prompt-assembly failure. Must degrade gracefully.

## ERR_MANDATORY_SKILL_MISSING

- **Trigger**: `preloadMandatorySkills` cannot locate `SKILL.md` for a listed skill in any search path.
- **User-visible message (log)**: `[mandatory-skills] skill file missing: <name> (source: <agents_md_project|agents_md_global|coding_txt>, searched: <paths>)`
- **Event**: `RuntimeEventService.append({ eventType: "skill.mandatory_missing", level: "warn", domain: "anomaly", anomalyFlags: ["mandatory_skill_missing"], payload: { skill, source, searchedPaths } })`
- **Layer**: Preload (`packages/opencode/src/session/mandatory-skills.ts`)
- **Log level**: `warn`
- **Recovery**: Skip this skill; continue with remaining list; do NOT call `recordLoaded` / `pin`. Session remains operational.
- **Rationale**: Honor AGENTS.md 第一條 (禁止靜默 fallback) — user gets loud signal + dashboard event, but session does not break.

## ERR_MANDATORY_SKILL_READ_FAILURE

- **Trigger**: SKILL.md file exists (path check passed) but read fails (permissions, I/O error, mid-read truncation).
- **User-visible message**: `[mandatory-skills] failed to read SKILL.md for <name>: <error.message>`
- **Event**: `skill.mandatory_read_error` (`anomalyFlags: ["mandatory_skill_read_error"]`)
- **Layer**: Preload
- **Log level**: `error`
- **Recovery**: Same as `ERR_MANDATORY_SKILL_MISSING` — skip the skill; emit event; continue.
- **Rationale**: Read errors are operational issues; don't crash the session, but surface them harder than a simple missing file.

## ERR_MANDATORY_UNPIN_MISSING_ENTRY

- **Trigger**: `reconcileMandatoryList` tries to `unpin` a skill that no longer has a registry entry (e.g. session was just created, or SkillLayerRegistry was cleared by session delete event).
- **User-visible message**: None (warn log only)
- **Layer**: Reconciler / SkillLayerRegistry
- **Log level**: `debug`
- **Recovery**: No-op; skip. Do NOT throw. No event emitted (not anomalous — expected in lifecycle race).

## ERR_MANDATORY_CACHE_INVALIDATION_FAILURE

- **Trigger**: `InstructionPrompt.systemCache` miss detection fails (mtime unreadable, filesystem race).
- **User-visible message**: `[mandatory-skills] cache mtime probe failed for <path>: <error>; falling back to full re-parse`
- **Layer**: Instruction loader
- **Log level**: `warn`
- **Recovery**: Force cache invalidation; re-parse all sources this round. Next round retries normal path.

## ERR_MANDATORY_COMPLETE_LIST_MISSING

- **Trigger**: Both global + project AGENTS.md have no sentinel block (or no AGENTS.md exists at all) for a Main Agent session.
- **User-visible message**: None (info log only, first round only)
- **Layer**: Resolver
- **Log level**: `info`
- **Recovery**: Return empty list; no preload; system operates without mandatory skills.
- **Rationale**: This is not an error — it's the opt-out state. Logging at `info` once per session avoids spam.

## ERR_AGENT_WORKFLOW_RESIDUAL_CALL

- **Trigger**: Session history / compacted context contains `skill({name: "agent-workflow"})` call but the skill is no longer in the library (post-retirement).
- **User-visible message (tool output)**: `skill not found: agent-workflow. This skill was retired on <date>. See docs/events/event_<YYYYMMDD>_agent-workflow_retirement.md for replacement mapping.`
- **Layer**: `skill` tool (`packages/opencode/src/tool/skill.ts`) — existing not-found path; this spec just verifies it doesn't crash.
- **Log level**: `warn`
- **Recovery**: AI receives the informative error, is expected to pivot (call `code-thinker` if the intent was debug contract; re-read AGENTS.md §3 for continuation rules).

## Error Catalogue

| Code | Layer | Level | Session Impact | Event Emitted |
|---|---|---|---|---|
| ERR_MANDATORY_SENTINEL_MALFORMED | parser | warn | none | `skill.mandatory_parse_warn` |
| ERR_MANDATORY_SKILL_MISSING | preload | warn | skill absent | `skill.mandatory_missing` |
| ERR_MANDATORY_SKILL_READ_FAILURE | preload | error | skill absent | `skill.mandatory_read_error` |
| ERR_MANDATORY_UNPIN_MISSING_ENTRY | reconciler | debug | none | — |
| ERR_MANDATORY_CACHE_INVALIDATION_FAILURE | cache | warn | extra I/O this round | — |
| ERR_MANDATORY_COMPLETE_LIST_MISSING | resolver | info | no preload | — |
| ERR_AGENT_WORKFLOW_RESIDUAL_CALL | skill tool | warn | AI gets error response | — |
