---
date: 2026-05-11
summary: "SHELVED — blocked on reference/codex-cli-reversed-spec; resume after upstream anatomy doc is rigorously audited"
---

# SHELVED — blocked on reference/codex-cli-reversed-spec; resume after upstream anatomy doc is rigorously audited

User directive 2026-05-11: "我覺得你必須把codex-cli原廠運作的拆解文件先建完整驗通過嚴謹稽核，免得老是在兜圈子重新掃碼。"

Pausing this spec at state=proposed. The bundle-slow-first fix targets a real cache-hygiene issue (user.system flips invalidate developer bundle prefix), but landing it without a rigorously-audited upstream reference document risks repeating the cache-4608 mistake — anchoring on a finding without time-ordering / cross-checking against the actual upstream wire shape.

Once `codex/cli-reversed-spec` (new plan, see Resume gate below) is verified and graduated to `/specs/codex/cli-reversed-spec/`, this spec resumes with two changes:

1. Every claim about "where fragment X currently sits" gets re-anchored to the reversed-spec sections, not re-derived from `refs/codex/` greps.
2. The fix design is re-validated: does the upstream codex-cli have an equivalent of `user.system` per-turn addenda? If yes, where does it ride? Match that.

Artifacts authored this session (proposal, spec, design, idef0, grafcet, c4, sequence, data-schema) are retained as-is. They represent the current best-effort understanding; the reference spec will either confirm or refine them.

## Resume gate
- `codex/cli-reversed-spec` reaches state=living (graduated to /specs/).
- That spec's section on "context fragments / bundle assembly" exists and is audited.
- User signals OK to resume.
