# Skills Repository Architecture

## Overview

This repository is a filesystem-based catalog of reusable agent skills. Each top-level skill directory packages one capability domain and is self-contained.

## Core Structure

- `/<skill-name>/SKILL.md`
  - Entry point for skill metadata and operating instructions.
- `/<skill-name>/LICENSE.txt`
  - License / terms for the skill when present.
- `/<skill-name>/scripts/**`
  - Executable helpers used by the skill.
- `/<skill-name>/references/**`, `assets/**`, `agents/**`, `eval-viewer/**`
  - Optional supporting materials loaded or used on demand.

## Repository Organization

- Skills are stored as top-level sibling directories (for example `docx/`, `pptx/`, `xlsx/`, `claude-api/`).
- `docs/events/` stores the development event ledger for repository maintenance tasks.
- `docs/ARCHITECTURE.md` documents the current high-level repository layout and operating model.
- `.github/workflows/` stores repository automation such as skill validation in CI.
- `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`, and `.github/release.yml` store contribution and release metadata for GitHub.

## Imported / Updated Skill Families

- Office/document skills: `docx`, `pdf`, `pptx`, `xlsx`
- Skill-authoring infrastructure: `skill-creator`
- API integration skill: `claude-api`
- Existing local-only skills remain alongside imported upstream skills.

## Merge Strategy

When upstream skills are imported:

1. Compare local and upstream skill names.
2. Add completely new skills as new top-level directories.
3. For duplicate skills, prefer upstream structure/content, then preserve useful local specializations instead of blind overwrite.
4. Keep legacy local-only files if they do not conflict with the upgraded skill.

## Current Notes

- `claude-api/` is now present as an imported upstream skill.
- Some upgraded skills keep intentional local deltas where they add useful repo-specific behavior (for example, the PDF skill retains additional ReportLab subscript/superscript guidance and normalized lowercase local file references).
- GitHub Actions validates every top-level skill directory by running `skill-creator/scripts/quick_validate.py` against each `*/SKILL.md`.
