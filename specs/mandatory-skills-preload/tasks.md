# Tasks: mandatory-skills-preload

Delegation-aware execution checklist. Phases map to IDEF0 activities (A1-A5) plus migration / cleanup work. Runtime executor (beta-workflow) materializes one phase's items at a time into TodoWrite per §16.1 of plan-builder.

## 1. Preflight — XDG Backup And Branch Prep

- [x] 1.1 Backup `~/.config/opencode/` whole directory to `~/.config/opencode.bak-<YYYYMMDD-HHMM>-mandatory-skills-preload/` (AGENTS.md 第二條 hard requirement) — done: `~/.config/opencode.bak-20260419-2355-mandatory-skills-preload/`
- [x] 1.2 Confirm `specs/mandatory-skills-preload/.state.json` is at `planned` before admission — done
- [x] 1.3 Decide build surface: direct `main` branch vs `beta-workflow` worktree — beta-workflow confirmed by user
- [x] 1.4 Create implementation branch — `beta/mandatory-skills-preload` in `/home/pkcs12/projects/opencode-beta`, based on main tip 19d05dfc0; `beta/autonomous-opt-in` preserved via tag `archive/autonomous-opt-in-20260419` + rename to `shelf/autonomous-opt-in`

## 2. Parser Module — A1 + A2 foundations

- [x] 2.1 Create `packages/opencode/src/session/mandatory-skills.ts` with pure exports — done: file created with types + 6 exports (parseMandatorySkills / parseMandatorySkillsBlocks / mergeMandatorySources / resolveMandatoryList / preloadMandatorySkills / reconcileMandatoryList / KEEP_RULES)
- [x] 2.2 Implement `parseMandatorySkills` — done; handles single+multi block, inline `#` comments, empty bullets, unclosed/nested blocks via loud warn, CRLF normalization
- [x] 2.3 Implement `resolveMandatoryList` — done; isSubagent+name=coding → coding.txt path; main agent → project+global AGENTS.md via pure `mergeMandatorySources` helper (project-priority dedup per DD-3)
- [x] 2.4 Write unit tests — done: 19 tests pass covering parser Scenarios (TV1-TV4), merge Scenarios (TV5-TV7), subagent short-circuit (TV8), dedup semantics, constants. TV9-TV15 deferred to §4.5 integration test.

## 3. Preload + Registry Integration — A3 + A4

- [x] 3.1 Verify `SkillLayerRegistry.unpin(sessionID, name)` matches DD-7 — already exists at [skill-layer-registry.ts:123-128](packages/opencode/src/session/skill-layer-registry.ts#L123-L128) with `pinned=false` + `runtimeState="idle"` + `lastReason="unpinned"`; `desiredState` untouched → next `applyIdleDecay` reclassifies. No code change needed. Also added `peek()` helper for reconcile diff efficiency.
- [x] 3.2 Added TV12 test to `skill-layer-registry.test.ts`: pinned entry with `lastUsedAt = now - 35min` under `billingMode: "token"` retains `runtimeState="sticky"`, `desiredState="full"`, `lastReason="session_pinned_keep_full"`. 5/5 registry tests pass.
- [x] 3.3 `preloadMandatorySkills` implemented in mandatory-skills.ts (§Phase 2.3 co-implementation): resolves via `Skill.get(name)` (search paths owned by Skill namespace), reads content, calls `SkillLayerRegistry.recordLoaded` + `.pin`, appends `skill.mandatory_preloaded` event
- [x] 3.4 Missing-file fallback per DD-5 done: `Skill.get` returns undefined → `log.warn` + `RuntimeEventService.append({eventType: "skill.mandatory_missing", anomalyFlags: ["mandatory_skill_missing"], ...})` per data-schema.json; read exceptions produce `skill.mandatory_read_error`
- [x] 3.5 `reconcileMandatoryList` implemented: iterates `SkillLayerRegistry.list()`, filters mandatory entries via keepRules containment (`mandatory:agents_md` / `mandatory:coding_txt`), unpins those not in desired, emits `skill.mandatory_unpinned` events
- [x] 3.6 Added 5 reconcile unit tests in mandatory-skills.test.ts covering TV13: unpin mandatory-pinned on removal, preserve user-pinned non-mandatory, no-op match, empty registry, coding_txt + agents_md both treated as mandatory. Preload end-to-end (TV9/TV10/TV11) deferred to §4.5 integration test where `Skill.get` has real skill library.

## 4. Runtime Wiring — A5 integration into session loop

- [ ] 4.1 Modify `packages/opencode/src/session/prompt.ts` `runLoop` (~line 1640 onwards): before assembling `system[]`, call `resolveMandatoryList` + `preloadMandatorySkills`; keep existing `instructionPrompts` + `skill-layer-seam` flow intact
- [ ] 4.2 Ensure call applies to Main Agent path (parentID === undefined) AND coding subagent path (`session.parentID && agent.name === "coding"`); skip for other subagents
- [ ] 4.3 After message processor completes (end of round), call `reconcileMandatoryList` so next round starts with a cleaned pinned set
- [ ] 4.4 Integrate mandatory-skills parsing results into `InstructionPrompt.systemCache` per DD-6 (cache key includes AGENTS.md mtime, same TTL)
- [ ] 4.5 Integration test via `packages/opencode/src/session/prompt.mandatory-skills.test.ts`: first round preloads + pins plan-builder; second round reuses cache; AGENTS.md edit mid-session triggers re-parse

## 5. AGENTS.md Content — 第三條 + Sentinel

- [ ] 5.1 Edit `packages/opencode/AGENTS.md` (repo-root): add 第三條 "自主 continuation 契約" after 第二條. Content covers: trigger conditions (spec implementing state + tasks.md residual + no block), stop conditions (approval / decision / unresolved blocker), mechanism (ending turn must include `todowrite` append if continuation conditions met), relationship to runloop pure-todolist judgement
- [ ] 5.2 Add `<!-- opencode:mandatory-skills -->\n- plan-builder\n<!-- /opencode:mandatory-skills -->` sentinel block under a new `## Mandatory Skills (runtime-preloaded)` section in `packages/opencode/AGENTS.md`
- [x] 5.3 Remove `templates/AGENTS.md:10` bootstrap directive — done
- [x] 5.4 Sync `templates/AGENTS.md` with repo-root — done; both have 第三條 + sentinel + Autonomous Agent 核心紀律
- [x] 5.5 Remove `agent-workflow` active references from `packages/opencode/AGENTS.md` — done; only historical retirement-context notes remain
- [x] 5.6 Parser verified against both files — `parseMandatorySkills()` → `["plan-builder"]` on each

## 6. coding.txt Update — subagent sentinel + agent-workflow purge

- [x] 6.1 Edit coding.txt §FIRST with sentinel + runtime preload note — done
- [x] 6.2 Remove "bug-fix → agent-workflow" reference; debug contract now lives in code-thinker — done
- [x] 6.3 Sync `templates/prompts/agents/coding.txt` — done (cp); parser → `["code-thinker"]`

## 7. code-thinker Absorbs Debug Contract — agent-workflow §5 migration

- [x] 7.1 Read agent-workflow §5 Syslog-style Debug Contract — done (full content captured)
- [x] 7.2 Diff against existing code-thinker — done; overlap = spec-checking emphasis, additions = five-checkpoint schema + component-boundary rules
- [x] 7.3 Rewrite code-thinker/SKILL.md with inlined debug contract as §3 — done; retained pre-existing WIP improvements (§1 6-step expansion, §3 output-gate version) while absorbing full debug contract
- [x] 7.4 Updated code-thinker description block to advertise debug contract coverage — done

## 8. agent-workflow Retirement

- [x] 8.1 `git rm -rf agent-workflow/` in /home/pkcs12/projects/skills/ submodule — done; committed as `9103663 refactor(skills): retire agent-workflow; absorb debug contract into code-thinker`
- [x] 8.2 Removed `"agent-workflow"` from both `packages/opencode/src/session/prompt/enablement.json` and `templates/prompts/enablement.json` `bundled_templates` — done
- [x] 8.3 (folded into 8.2)
- [x] 8.4 Grepped residual references — active references in `templates/system_prompt.md` (bootstrap + state machine section) and `templates/global_constitution.md` (bootstrap) rewritten to point at mandatory-skills preload + AGENTS.md Autonomous Agent 核心紀律; historical notes retained for retirement context; `templates/backup/AGENTS.md` left alone (backup file, non-runtime). Test fixture `llm.skill-layer-seam.test.ts` renamed to use neutral `example-summarized-skill`.
- [x] 8.5 `skill` tool's existing not-found path (skill.ts line 66) already throws with available list; no new code needed. Behavior confirmed from inspection.
- [x] 8.6 Submodule pointer bumped in opencode-beta worktree: `git add templates/skills` stages the pointer update to 9103663.

## 9. Documentation And Architecture Sync

- [x] 9.1 Event log for this feature + retirement — single consolidated event `docs/events/event_20260419_mandatory_skills_preload.md` with Phase 1-9 summaries (covers both retirement rationale and new preload mechanism, per AGENTS.md 第零條 留痕原則)
- [x] 9.2 (merged into 9.1 — single event file)
- [x] 9.3 `specs/architecture.md` updated with new `## Mandatory Skills Preload Pipeline` section covering data flow, sentinel syntax, source authorities, observability events, current mandatory lists, agent-workflow retirement cross-reference
- [x] 9.4 `plan-sync.ts` run — clean (no code drift from main repo perspective; actual impl changes live in beta branch pending fetch-back)

## 10. Acceptance And Verification

- [x] 10.1 `bun test src/session/mandatory-skills.test.ts` — 24 pass / 0 fail (19→24 after reconcile suite added)
- [x] 10.2 `bun test src/session/skill-layer-registry.test.ts` — 5 pass / 0 fail (TV12 pinned-aged test + peek test added)
- [x] 10.3 `bun test test/session/mandatory-skills-integration.test.ts` — 6 pass / 0 fail (TV9 missing / TV10 preload+pin / TV11 idempotent / main vs coding subagent dispatch)
- [ ] 10.4-10.8 Manual verification — **PENDING**: 需要使用者重啟 daemon + 開新 session + 實地觀察 dashboard「已載技能」面板行為 + idle-decay 測試 + 缺檔 fallback 測試 + AGENTS.md 編輯後 unpin 測試。automation 測試已覆蓋機制，實際 UI 驗證需使用者操作
- [ ] 10.9 `plan-validate.ts` at `verified` target — 待 fetch-back 完成且 manual 驗證全綠後再 promote
- [ ] 10.10 State promotion `implementing → verified → living` — 同上，等 Phase 11 fetch-back 完成

## 11. Cleanup

- [ ] 11.1 Delete implementation beta branch (if used); remove any `opencode-worktrees/` temp worktree
- [ ] 11.2 Remind user: backup `~/.config/opencode.bak-<timestamp>-mandatory-skills-preload/` exists; user decides whether to delete. AI does NOT auto-delete (第二條)
- [ ] 11.3 Update this tasks.md final state — all `- [x]`, ready for `verified` promotion
