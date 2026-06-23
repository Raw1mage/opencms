---
date: 2026-06-24
status: done
tags: [claude-cli, protocol, reverse-engineering, betas, model-registry]
summary: "Re-extract protocol constants from claude-code 2.1.186 native ELF; re-pin datasheet + bump provider to 2.1.186"
---

# Sync provider-claude / datasheet to claude-code 2.1.186

## Trigger

npm `@anthropic-ai/claude-code` advanced to **2.1.186** (datasheet pinned to
2.1.170, provider VERSION at 2.1.178). Pulled `@anthropic-ai/claude-code-linux-x64@2.1.186`
(the platform native dep — 71 MB tarball → 224 MB Bun-compiled ELF, x86-64,
**not stripped**, BuildID `a1550bc4ade7d8b420623aedad9d9401d7ef8773`) and ran
`strings` over it. The beta registry array and per-model max-output tiers were
read directly from the embedded minified JS.

Build metadata: `VERSION 2.1.186`, `BUILD_TIME 2026-06-22T16:43:00Z`,
`GIT_SHA 6a56aff51d9e9faf62f26f2748501c2e32eec5e8`.

## What changed (wire protocol — small)

1. **`claude-opus-4-8` ships.** Model registry display names `"Opus 4.8 (1M context)"`
   / `"Opus 4.8"`, 1M-context capability, **64000/128000** max-output tier
   (`…==="claude-opus-4-8")t=64000,n=128000`). Also present: `claude-opus-4-6-fast`,
   `claude-mythos-preview`.
2. **Beta registry row-28 date drift.** Registry now built as
   `EUu=Object.freeze([…NS(name,header)…].filter(e=>e!==null))` (was `U31`).
   Membership/order **identical to 2.1.170** (28 entries) except `fallback_credit`:
   `fallback-credit-2026-06-09 → fallback-credit-2026-06-01`.
3. **Two new non-registry beta surfaces:** `oidc-federation-2026-04-01`,
   `mcp-client-2025-11-20`. API-specific, not in `EUu`.

## Re-verified unchanged

`CLIENT_ID 9d1c250a-e61b-44d9-88ed-5944d1962f5e`; `ATTRIBUTION_SALT 59cf53e54c78`;
`anthropic-version 2023-06-01`; OAuth UA `axios/1.15.2` (`"axios/"+oOe`,
`oOe="1.15.2"`); billing shape (`cc_version=`/`cc_entrypoint=`/`cch=00000`
hardcoded/`cc_workload=`); `anthropic-client-platform` 8-value map; OAuth
endpoints; OAuth scopes (6).

## What changed (code)

- `protocol.ts`: `VERSION 2.1.178 → 2.1.186` (feeds inference-path UA, attribution
  hash, `cc_version=`). Header changelog + datasheet pointer updated
  (`plans/claude-provider/protocol-datasheet.md` → `specs/claude-cli/cli-reversed-spec/...`).
- `models.ts`: source-of-truth version stamp `2.1.178 → 2.1.186`.
- `scripts/sync-from-cli.ts`: `PINNED_VERSION → 2.1.186`; **LMH extractor regex
  made minifier-drift-proof** — the old `/K==="…"\)\$=…/` matched 0 entries on
  2.1.186 because the minifier renamed the comparison/assignment vars
  (`K/$/q → r/t/n`). Now matches structurally (`==="(claude-…)"\)<var>=N,<var>=N`).
- `OAUTH_USER_AGENT` unchanged (`axios/1.15.2`).

## Verification

- `sync-from-cli.ts` (post-bump): **`✓ ALIGNED — 53 fields against 2.1.186`**,
  exit 0. LMH table now extracts 12 entries; `opus-4-8` 64000 matches.
- `bun test`: **107 pass / 0 fail**.

## Provider stance (unchanged)

Fingerprint-only bump. The fallback betas + new non-registry surfaces are
statsig-/feature-gated upstream and stay **OUT** of `assembleBetas`. The provider
still emits only the normal-subscription-inference subset.

## Notes

- Binary carries uncatalogued 4.x IDs `claude-opus-4-2`, `claude-sonnet-4-2`
  (not public; likely internal/test aliases) — flagged by the tool as a NOTE,
  not added to the catalog.
- 2.1.186 npm wrapper mirrored at `refs/claude-code-npm/wrapper-2.1.186/` (refs/
  is gitignored). Native ELF analysis done in XDG runtime workdir, not committed.

## Cross-refs

- `chapters/protocol-datasheets.md` §13 (full delta)
- `refs/claude-code-npm/REFS.md` (binary-extraction procedure)
- `packages/provider-claude/scripts/sync-from-cli.ts` (drift tool)
- Prior: `event_2026-06-10_sync-provider-claude-to-cli-2.1.170-fable5.md`,
  `event_2026-06-09_sync-provider-claude-to-cli-2.1.169.md`
