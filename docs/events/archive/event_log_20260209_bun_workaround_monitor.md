# Bun Issue #19936 Workaround Monitor

**Date**: 2026-02-09  
**Priority**: Low  
**Status**: Monitoring

---

## Issue Summary

**Bun GitHub**: https://github.com/oven-sh/bun/issues/19936  
**Affected Code**: `src/bun/index.ts:96-97`

```typescript
// TODO: get rid of this case
...(proxied() ? ["--no-cache"] : []),
```

**Problem**: When Bun uses a corporate proxy, package installation fails without the `--no-cache` flag.

---

## Current State

**Bun Version**: 1.3.5 (checked on 2026-02-09)  
**Workaround Status**: ✅ ACTIVE (required for proxy environments)

```typescript
// When using proxy, add --no-cache flag
const args = [
  "add",
  "--force",
  "--exact",
  ...(proxied() ? ["--no-cache"] : []),  // 🔴 Workaround
  "--cwd",
  Global.Path.cache,
  pkg + "@" + version,
]
```

---

## Monitoring Action

### When to Remove Workaround

Remove `--no-cache` workaround when **ALL** of the following are true:

1. **Bun issue is CLOSED** (issue/19936 marked as "resolved" or "fixed")
2. **Bun version is >= next release after fix** (e.g., if fixed in 1.4.0, wait until 1.4.0+ is stable)
3. **Test in proxy environment confirms** that `bun add` works without `--no-cache`

### Monitoring Checklist

- [ ] Subscribe to Bun issue #19936 for updates
- [ ] Check Bun release notes monthly
- [ ] When Bun version bumped in `bunfig.toml`:
  - [ ] Check if issue is mentioned in changelog
  - [ ] If fixed: Remove workaround and test in proxy environment
- [ ] Every quarter: Review Bun issue status (Feb, May, Aug, Nov)

---

## Removal Steps

When issue is resolved:

1. **Remove the workaround**:
```diff
- ...(proxied() ? ["--no-cache"] : []),
```

2. **Update this document**:
```diff
- **Workaround Status**: ✅ ACTIVE
+ **Workaround Status**: ❌ REMOVED (as of Bun X.X.X)
+ **Date Removed**: YYYY-MM-DD
```

3. **Create new commit**:
```
fix(bun): remove workaround for issue #19936 (fixed in Bun X.X.X)

The --no-cache flag workaround is no longer needed.
Bun now handles proxy environments correctly.
```

---

## Related Info

- **Repository**: `/home/pkcs12/opencode/`
- **Affected File**: `src/bun/index.ts` (lines 96-97)
- **Test Command**: `bun install` in proxy environment
- **Last Checked**: 2026-02-09 (Bun 1.3.5)

---

## Historical Record

| Date | Bun Version | Status | Action |
|------|-------------|--------|--------|
| 2026-02-09 | 1.3.5 | Active | Initial monitoring created |
| - | - | - | - |

---

**Next Review**: 2026-05-09 (quarterly check)
