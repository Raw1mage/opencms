# Batch9E SDK dist rootdir hygiene (rewrite-only)

Date: 2026-02-27
Source: `origin/dev` (`443214871eda069f81cba19b5a3eecfce0fa314e`)
Target: `cms`

## Scope

- Continue low-risk SDK packaging alignment.

## Changes

1. `.gitignore`
   - Ignore `tsconfig.tsbuildinfo` at repo root to avoid accidental check-ins.
2. `packages/sdk/js/tsconfig.json`
   - Set `compilerOptions.rootDir = "src"` to keep declaration output rooted at `dist/` path structure.

## Notes

- Upstream also adjusted `packages/sdk/js/package.json` export type paths.
- In cms, current SDK dist layout already resolves to `dist/v2/...`; package export shape diverges intentionally and is left unchanged.

## Validation

- `bun run typecheck` in `packages/sdk/js` ✅
