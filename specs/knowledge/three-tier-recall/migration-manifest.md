# MEMORY.md migration manifest (Phase 5 — non-destructive)

Source: `~/.claude/projects/-home-pkcs12-projects-opencode/memory/`
- `MEMORY.md` — 470-line resident index (~52KB; over the 25KB eager cap).
- **152 topic files** (`feedback_*`=76, `project_*`=71, `reference_*`=3, `user_*`=2), **~321KB total**, the actual knowledge bodies.

## Decisive finding

The topic files are **local-disk-only (not a git repo)** and only **partially** duplicated in `docs/events`. Emptying `MEMORY.md` (the index) without first making the topic files retrievable would **orphan** them — present on disk, but invisible to every recall path. The original "history is already in git+events → deletable" assumption (DD-5) holds for *some* entries, not the bulk.

## Disposition buckets (by kind, not per-line)

| Bucket | ~Count | Disposition |
|---|---|---|
| **Every-turn RULES already codified** in AGENTS.md/CLAUDE.md (no silent fallback, XDG backup, daemon-restart consent, PR-default-off, never-rm-tracked, beta XDG isolation) | ~10 | Verify present in AGENTS.md → drop from MEMORY (already a rule). |
| **Every-turn behavioral RULES not yet codified** (don't-perform-honesty, don't-punt-decisions, plain-language-over-function-names, radical-simplification, use-question-tool, "Other"-is-guidance, destructive-tool-guard) | ~8 | Promote to AGENTS.md (these are genuinely binding + frequent). |
| **Distilled knowledge / RCA / method lessons** (the bulk: cache-thrash DD-18..22, CJK undercount, fd leak, overflow replay, oauth throttle, rotation cascade, grafcet rules, codex issues, …) | ~110 | **Make retrievable** (see recommendation) → then drop index entry. NOT every-turn rules; they are recall material. |
| **Reference facts** (Hosts rawdb/rawbase, Key Architecture data paths, Skills SSOT, multi-user accounts) | ~6 | Promote durable ones to an AGENTS.md `## Reference` block; rest indexed as recall. |
| **Procedure** (3R ×2 entries) | 2 | `/3r` skill (daemon rule in AGENTS.md already names webctl restart --force). |
| **Stale STATE / progress flags** (llama.cpp temp-disabled, freerun planned-state, various PENDING/PAUSED/SHELVED) | ~16 | Drop — per the user's own MEMORY hygiene rule these never belonged here; live state is in plans/.state.json + events. |

## The fork this surfaces

To retire MEMORY.md **without losing the ~110 recall-bucket bodies**, the 152 topic files must become retrievable. Options:

- **(A, recommended) Index the memory dir as a third event source.** The topic files ARE the curated event/decision tier (higher quality than raw event logs). Add `~/.claude/.../memory/*.md` to the events index (needs indexEvents to accept an absolute external source). One config line; emptying MEMORY.md then loses nothing; the 152 bodies become `event_search`-able alongside the 992 events.
- **(B) Fold valuable topic files into `docs/events`.** Manual, lossy curation; high effort; mixes Claude-memory provenance into the repo's event log.
- **(C) Separate `memory.sqlite` + own tool.** Cleanest separation but a 4th store + query surface (more moving parts).

Recommendation: **A** — simplest, and it matches the architecture (topic files = distilled event/decision tier). It is a small extension to the locked DD-3 source list, so it is the user's call.

## Gate

Phase 6 (empty MEMORY.md + retire EVENT_LOG_UNIFIED stub) stays **blocked** until the chosen option lands and the recall-bucket bodies are verified findable (G5 / AC7).
