# Batch10K Release/docs policy decision batch (rewrite-only)

Date: 2026-02-27
Source: `origin/dev` (release/docs/agent maintenance commits)
Target: `cms`

## Scope

- Record skip decisions for commits that conflict with cms release policy or non-runtime docs-agent pipeline.

## Decisions

### Release bump commits skipped

- `1eb6caa3c` (v1.2.9)
- `296250f1b` (v1.2.10)
- `29ddd5508` (v1.2.11)
- `d848c9b6a` (v1.2.13)
- `de2bc2567` (v1.2.14)
- `799b2623c` (v1.2.15)

Reason: cms keeps independent versioning/release cadence; upstream release-tag churn is not rewrite-ported.

### Docs/agent glossary workflow commits skipped

- `7e0e35af3` (`chore: update agent`)
- `c45ab712d` (`chore: locale specific glossaries`)
- `dbf2c4586` (`chore: updated locale glossaries and docs sync workflow`)
- `b368181ac` (`chore: move glossary`)
- `08f056d41` (`docs: Sync zh_CN docs with English Version`)

Reason: outside cms runtime/product behavior scope; localization/docs-agent sync handled in separate docs cycle.

## Validation

- Decisions appended to processed ledger with explicit rationale.
