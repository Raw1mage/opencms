# Batch10M Docs-only policy skips (rewrite-only decision)

Date: 2026-02-27
Source: `origin/dev` (docs/readme-only updates)
Target: `cms`

## Scope

- Process docs-only commits that do not affect cms runtime behavior and are covered by cms docs cadence/policy.

## Decisions

1. `5a1aca918` `docs: add Bangla README translation`
   - README localization expansion across many root README language files.
   - Decision: **skipped** (docs localization handled in separate cms documentation cycle).
2. `d0ce2950e` `chore: generate`
   - Follow-up generated change touching only `README.bn.md`.
   - Decision: **skipped** (paired with skipped README localization stream).
3. `a41c81dcd` `docs(ko): improve wording ...`
   - Korean docs copy edits in web docs.
   - Decision: **skipped** (non-runtime wording updates; handled by docs cycle).
4. `76b60f377` `desktop: make readme more accurate`
   - Desktop package README text refinement only.
   - Decision: **skipped** (docs-only; no runtime/packaging delta).
5. `2a87860c0` `zen: gpt 5.3 codex`
   - Docs model reference update in `packages/web/src/content/docs/zen.mdx`.
   - Decision: **skipped** (docs publication cadence diverges; no codepath impact).

## Validation

- Verified each commit file list is docs/readme-only.
- Confirmed no runtime source files, build scripts, or workflow behavior changed.
