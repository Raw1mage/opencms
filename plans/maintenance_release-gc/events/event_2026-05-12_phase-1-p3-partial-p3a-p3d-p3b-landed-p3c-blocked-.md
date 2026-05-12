---
date: 2026-05-12
summary: "Phase 1 P3 partial — P3a/P3d/P3b landed; P3c blocked on submodule secrets audit"
---

# Phase 1 P3 partial — P3a/P3d/P3b landed; P3c blocked on submodule secrets audit

**Commits:**

- `f79d3001a` — `chore(gc/c7-p3a): exclude retired planner/ from dev sync-back` (rsync exclude on script/sync-config-back.sh so local ghost copies can't resurrect deleted template)
- `83346020b` — `docs(gc/c7-p3d): rewrite sdd_framework.md as historical/superseded note` (243 → 38 lines; concept-mapping table from planner to plan-builder; points readers to plan-builder SKILL.md + launch event)
- `58bb4ec7a` — `chore(gc/c7-p3b): add OPENCODE_PLAN_BUILDER_TEMPLATE_DIR env alias` (both old and new names point to /etc/opencode/specs; no opencode runtime reads either)

**P3c BLOCKED — submodule push gate:**

`templates/skills/` is a git submodule pointing at github.com/Raw1mage/skills. Deleting `templates/skills/planner/` requires:
1. Submodule-side `git rm` + commit
2. Push to github.com:Raw1mage/skills (public-ish repo)
3. opencode-side submodule pointer bump + commit

Pre-push audit found a separate sanitization problem in the submodule:

`templates/skills/synology_nginx/SKILL.md` contains internal LAN IPs
(192.168.100.10/40/80), personal SSH login (`yeatsluo@192.168.100.40`),
internal hostname `rawdb`, and 9 Synology reverse-proxy entries listing
internal_domain → UUID → port (cms.thesmart.cc, crm.sob.com.tw,
suno.thesmart.cc, miat.thesmart.cc, www.thesmart.cc,
www.jewelcity.com.tw, registore.thesmart.cc, etc.). Cannot push the
submodule until this is sanitized or relocated.

User decision pending: (A) move synology_nginx to private repo,
(B) generalize values in-place, or (C) archive synology_nginx entirely.

**Audit false positives confirmed clean:**

- `claude-api/*` `"your-api-key"` placeholder text — fine
- `opencode_installation/` `AIzaSyCy...` is elided documentation placeholder
- `mcp-builder/*` `token123` / `your_api_key_here` placeholders — fine
- `canvas-design/canvas-fonts/*-OFL.txt` font OFL license author emails — legitimate attribution

**Phase 1 totals so far:**

- C4: 1 commit (75665d8ce)
- C7 (planner retirement): 5 commits so far (ea2e1a90f / 2578ed938 / f79d3001a / 83346020b / 58bb4ec7a) — C7c remaining
- P5 (memory): updated MEMORY.md Global.Path.data framing</body>
</invoke>
