---
date: 2026-05-12
summary: "P3c unblocked + executed (skills repo turned private, planner template deleted)"
---

# P3c unblocked + executed (skills repo turned private, planner template deleted)

**Resolution of the synology_nginx blocker:**

User chose option (3) — turn `github.com/Raw1mage/skills` from PUBLIC to PRIVATE
instead of sanitizing the synology_nginx skill in place. Verified post-change:
`isPrivate: true`, 0 fork, 0 star (no known external clones).

**Submodule work:**

- Branched at submodule HEAD (376a75a) into `chore/retire-planner-skill`
- `git rm -r planner/` deleted 3 files / 1749 lines
- Commit `adc7fd7` in submodule
- Pushed branch to origin (`/home/pkcs12/projects/skills`) as named branch
  (couldn't FF main directly: divergent lineage, main has 2 commits not in
  HEAD — left intact for user)
- Pushed branch to `github.com:Raw1mage/skills` as main (FF
  `54c690e..adc7fd7`, 40 commits including 39 previously-unpushed local
  skills work)

**Opencode-side commit:**

- `14c11b0d3` — `chore(gc/c7-p3c): bump templates/skills pointer to drop planner template`
- Submodule pointer 376a75a → adc7fd7

**Outstanding history exposure:**

- synology_nginx content still in git history of the now-private repo
- Decided in user authorization "3": accept current private protection
  level rather than nuclear history rewrite
- 0 fork / 0 star at the moment of visibility change minimizes exfiltration risk

**Remaining Phase 1 P3 items (deferred, not blocked):**

- P3e — templates/prompts/session/plan.txt still references `plan-init.ts`
  / `plan-validate.ts` script names; works incidentally because plan-builder
  template has the same script names, but text should be reframed to
  specbase MCP. Live /plan-mode test needed.
- P3f — user's local `~/.claude/skills/planner/`,
  `~/.config/opencode/skills/planner/`,
  `~/.local/share/opencode/skills/planner/` — user-owned, P3a sync-back
  exclude already prevents resurrection regardless of deletion choice.

**Phase 1 commit chain (opencode side, oldest first):**

8263c1842 → 75665d8ce → ea2e1a90f → 2578ed938 → 6215704be → f79d3001a →
83346020b → 58bb4ec7a → d60adfc8c → 14c11b0d3 (current)</body>
</invoke>
