# skills

[![Validate Skills](https://github.com/Raw1mage/skills/actions/workflows/validate-skills.yml/badge.svg)](https://github.com/Raw1mage/skills/actions/workflows/validate-skills.yml)
[![Release](https://img.shields.io/github/v/release/Raw1mage/skills)](https://github.com/Raw1mage/skills/releases)

Reusable agent skills catalog for local use and upstream-sync experimentation.

## Structure

Each top-level directory is a skill package, typically containing:

- `SKILL.md` — trigger metadata and operating instructions
- `scripts/` — executable helpers
- `references/`, `assets/`, `agents/`, `eval-viewer/` — optional support files

## Included skill families

- Office/document workflows: `docx`, `pdf`, `pptx`, `xlsx`
- API integration: `claude-api`
- Skill authoring: `skill-creator`
- Additional local and imported specialty skills in sibling directories

## Maintenance model

- Upstream skills can be imported and compared against local copies
- Duplicate skills are merged intentionally rather than blindly overwritten
- Repo-level maintenance notes live in `docs/events/`
- High-level structure is documented in `docs/ARCHITECTURE.md`

## Repository automation

- GitHub Actions validates all top-level skills on push and pull request via `.github/workflows/validate-skills.yml`
- Validation uses `skill-creator/scripts/quick_validate.py` across each top-level `*/SKILL.md`

## GitHub repo

- Repository: https://github.com/Raw1mage/skills
- Default collaboration target: `main`
- Releases/tags can be used to mark import and refactor milestones
