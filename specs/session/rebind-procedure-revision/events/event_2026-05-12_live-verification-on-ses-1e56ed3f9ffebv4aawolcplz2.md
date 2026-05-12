---
date: 2026-05-12
summary: "Live verification on ses_1e56ed3f9ffebv4AaWOlcPLz20"
---

# Live verification on ses_1e56ed3f9ffebv4AaWOlcPLz20

Multi-stage live verification on the same session that originally exhibited the 11-round read-loop (跳針):

**Stage 1 — control plane (Phase B/C post-restart):**
- 19:25:09 account_switch (raw → yeatsluo): chain.commitment.captured digestEntryCount=5 → session.rebind chainBreakClass=SS-break → chain.init.injected bodyCharCount=797. All three events fired within 30ms.

**Stage 2 — data plane (after C+ hotfix `a89fef9c9` + restart):**
- 20:04:50 account_switch (yeatsluo → raw): control-plane chain.* events fired as before. **AND** subsequent `llm.prompt.telemetry` showed `bundle_user` fragmentIds:
```
[agents_md:global, agents_md:project, amnesia_notice, chain_init_notice, environment_context]
```
Confirming chain_init_notice actually reaches codex.

**Stage 3 — Phase D + polish (after `670c44046` + `861f2a3a4` + restart):**
- 20:55:00 account_switch (raw → humanresource): session.rebind payload carried `chainBreakClass: "SS-break"`.
- A subsequent compaction_narrative event produced `chain.init.skipped` with `reason: "amnesia_supersedes"` (was "unspecified" pre-polish).

**Stage 4 — dedup hotfix (after `b8df87855` + restart):**
- First dispatch in fresh process: bundle gains chain_init_notice once.
- Subsequent prompt builds with same stale anchor: dedup-skipped, chain_init_notice absent from bundle. End-to-end verified per `b3q25w7ls` monitor.

Pre-this-work the same session reproduced the 11-round read-loop. Post-this-work: 50+ rounds across 9 different chapter files completed without跳針.
