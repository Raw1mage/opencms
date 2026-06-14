# Bug Report: `apply_patch` false-success / path resolution ambiguity

## 0. Handoff Summary

This report documents a suspected `apply_patch` tool bug observed during a document/report-generation session in `/home/pkcs12/projects/documents`.

The key failure mode is: **`apply_patch` reported success, but a subsequent `read` of the target file showed that the expected content was not changed**. The issue was observed around mounted/symlinked Google Drive paths and a relative path escaping the current workspace.

This file is also a proposed **standard bug-report format** that should be promoted into a reusable `bug-report` skill. Bug report filenames should follow `<date><title>_issue.md`, using `YYYYMMDD` plus a concise snake_case title, for example `20260513_apply_patch_false_success_path_resolution_issue.md`.

## 1. Bug Identity

| Field | Value |
|---|---|
| Title | `apply_patch` may return success without modifying the intended file |
| Component | OpenCode tool runtime / `apply_patch` tool |
| Reporter | Main Agent session in `/home/pkcs12/projects/documents` |
| Date | 2026-05-13 |
| Severity | High for agent reliability; medium for data safety |
| Priority | P1 if reproducible |
| Status | Needs reproduction in a clean session |
| Affected tool | `functions.apply_patch` |
| Related paths | `gdrive/@Template/doc_rules.md`, `../drawmiat/plans/mcp_output-solution-artifacts/proposal.md` |

## 2. Expected Behavior

When `apply_patch` returns success:

1. The requested file mutation should have been applied to the resolved target file.
2. A subsequent `read` of the same logical target should show the new content.
3. The response should identify what changed, ideally including:
   - resolved absolute path
   - realpath after symlink resolution
   - number of files changed
   - number of hunks applied
   - whether the patch was a no-op
4. If the path is unsupported, unsafe, outside the workspace, read-only, or resolves ambiguously, the tool should fail fast.

## 3. Actual Behavior Observed

### Case A: Google Drive path under `documents/gdrive`

Target file:

```text
/home/pkcs12/projects/documents/gdrive/@Template/doc_rules.md
```

Observed behavior:

1. `read` showed old rule content.
2. `apply_patch` was called against relative path:

```text
gdrive/@Template/doc_rules.md
```

3. `apply_patch` returned success.
4. A subsequent `read` still showed old content.
5. The agent had to fall back to Python line-based rewrite to guarantee the content changed.

Important context:

- During the same session, `documents/gdrive` had recently been discussed as symlink / hardlink / mount-point related.
- The user later clarified that `documents/gdrive` was a real hard-link / restored path.
- The drive was briefly read-only and later verified writable.

### Case B: Relative path escaping current workspace

Target file intended:

```text
/home/pkcs12/projects/drawmiat/plans/mcp_output-solution-artifacts/proposal.md
```

Patch path used from cwd `/home/pkcs12/projects/documents`:

```text
../drawmiat/plans/mcp_output-solution-artifacts/proposal.md
```

Observed behavior:

1. `apply_patch` returned success.
2. Later `read` of the intended drawmiat plan file showed the plan-init placeholder still present.
3. The agent rewrote the file using Python and then verified with `read`.

Open question:

- Was `../` accepted and applied somewhere unexpected?
- Was it silently normalized, rejected internally but reported success, or applied to a different resolved path?

## 4. Impact

This is risky for autonomous coding/document agents because it creates a **false-positive mutation**:

1. The agent believes the file was changed.
2. The agent continues downstream work based on a false assumption.
3. Validation can become inconsistent or delayed.
4. In plan-builder workflows, a false-success write can cause lifecycle promotion attempts against stale artifacts.

Potential user-visible effects:

- docs claim a rule was updated, but file remains unchanged
- generated artifacts use old rules
- plan files remain placeholders while the agent reports progress
- repeated fallback writes create confusion about which write path is canonical

## 5. Evidence From Session

Known tool-call references from the compacted session narrative:

| Evidence | Tool call id | Summary |
|---|---|---|
| E1 | `call_hiAVQej563UZFzNIFCbPIPAg` | `apply_patch` updated `gdrive/@Template/doc_rules.md`, returned ok |
| E2 | `call_AenUODZFC1R1S6BYzLgDFUaH` | `read` of `gdrive/@Template/doc_rules.md` still showed old wording |
| E3 | `call_V3rs0fn4yQnUyWDBwgXomqEw` | `apply_patch` updated `../drawmiat/plans/.../proposal.md`, returned ok |
| E4 | `call_drKLEE0lzGmFU8MvjSuKwzT2` | later `read` of proposal showed placeholder content |
| E5 | `call_RnRl9QT4PuZLeqo9vFRq6qTj` | Python rewrite used to force proposal/design/tasks content |

If investigating in a resumed session, use `recall(<tool_call_id>)` to retrieve original outputs before trusting this summary.

## 6. Preliminary Root-Cause Hypotheses

These are hypotheses, not confirmed causes:

### H1: Success is reported even when zero hunks were applied

`apply_patch` may be treating a parsed patch as successful even when the effective changed-file count is zero.

Expected fix:

- distinguish parse success from apply success
- return `no-op` or error when no file content changed unless explicitly allowed

### H2: Path resolution differs between `apply_patch` and `read`

`apply_patch` may resolve relative paths, symlinks, hardlinks, mount points, or `../` differently from the `read` tool.

Expected fix:

- response should include:
  - cwd
  - requested path
  - normalized path
  - resolved absolute path
  - realpath

### H3: `../` path escape is allowed but not clearly defined

The tool documentation says paths are relative and never absolute, but does not explicitly specify whether `../` is permitted.

Expected fix:

- either reject `..` segments with a clear error
- or support them intentionally and report the final resolved path

### H4: Mounted/symlinked paths expose stale or alternate target behavior

Google Drive mount/symlink/hardlink state changed during the session. If `apply_patch` opens one path while `read` resolves another, false mismatch can occur.

Expected fix:

- use the same filesystem resolution policy across tools
- include inode/device or realpath in mutation responses when possible

## 7. Suggested Reproduction Plan

Run in a clean session.

### Repro 1: no-op / false-success check

1. Create a temporary file under a normal workspace path.
2. `read` it.
3. Run `apply_patch` with a valid-looking update hunk.
4. Immediately `read` it.
5. Confirm whether content changed.
6. Confirm whether `apply_patch` output reports changed-file count.

### Repro 2: symlink path check

1. Create a real directory `target/` with `file.md`.
2. Create symlink `link -> target`.
3. `read` `link/file.md`.
4. `apply_patch` `link/file.md`.
5. `read` both `link/file.md` and `target/file.md`.
6. Compare inode/mtime/content.

### Repro 3: `../` escape check

1. Set cwd to workspace A.
2. Create or target a file under sibling workspace B.
3. Call `apply_patch` with `../B/path/file.md`.
4. Check whether it is rejected, applied, or silently redirected.
5. Verify response path metadata.

### Repro 4: mount / hardlink path check

If safe and available:

1. Use a mounted path or bind-mounted directory.
2. Patch via mount-facing path.
3. Read via both mount path and real path.
4. Compare behavior.

## 8. Acceptance Criteria For Fix

A fix should satisfy all of the following:

1. `apply_patch` never returns plain success if no file bytes changed, unless the response explicitly says `no-op`.
2. The response includes a structured mutation summary:

```json
{
  "status": "success|no_op|error",
  "requestedPath": "gdrive/@Template/doc_rules.md",
  "normalizedPath": "gdrive/@Template/doc_rules.md",
  "absolutePath": "/home/pkcs12/projects/documents/gdrive/@Template/doc_rules.md",
  "realPath": "/resolved/target/path",
  "filesChanged": 1,
  "hunksApplied": 2,
  "bytesBefore": 1234,
  "bytesAfter": 1456
}
```

3. Unsupported paths fail fast:
   - absolute paths
   - disallowed `../` escapes
   - read-only target
   - file exists but is not the resolved file expected by workspace policy
4. `apply_patch` and `read` use consistent path-resolution semantics.
5. Tests cover normal files, symlinks, sibling path escape, and no-op patches.

## 9. Workaround Used In Session

When `apply_patch` became unreliable, the agent used Python scripts to rewrite files and then immediately verified with `read`.

This is not ideal because:

- it bypasses the intended file-editing toolchain
- it can hide tool-level bugs
- it adds more ad hoc file mutation logic

Recommended temporary workaround until fixed:

1. After any `apply_patch`, immediately `read` the target file.
2. Treat `apply_patch` success as untrusted unless verification confirms the intended content.
3. Avoid `../` paths in `apply_patch`.
4. Avoid patching through unstable symlink/mount paths when a canonical real path is available.

## 10. Proposed Standard Skill: `bug-report`

The user requested that bug reporting be standardized as a skill. Below is the proposed skill contract.

### Skill Name

`bug-report`

### Trigger

Use this skill when the user says any of:

- "write a bug report"
- "file an issue"
- "make this reproducible"
- "document this bug"
- "create an issue for next session"
- "這個 bug 幫我寫 report"
- "讓新 session 接手處理"

### Purpose

Produce a handoff-quality bug report that lets a fresh session reproduce, diagnose, prioritize, and fix the issue without relying on chat history.

### Required Sections

Every bug report MUST include:

1. **Handoff Summary**
   - 3-8 sentence summary
   - what failed
   - why it matters
   - current status

2. **Bug Identity**
   - title
   - component
   - reporter/session
   - date
   - severity
   - priority
   - status
   - affected versions/tools/paths

3. **Environment**
   - repo path
   - cwd
   - OS/runtime if known
   - relevant mounts/symlinks/services
   - tool versions if known

4. **Expected Behavior**
   - explicit contract
   - success criteria
   - invariants that must hold

5. **Actual Behavior**
   - exact observed behavior
   - error messages
   - stale output
   - screenshots/logs if available

6. **Steps To Reproduce**
   - minimal numbered steps
   - exact commands/tool calls where possible
   - required fixtures/files
   - what to observe at each step

7. **Evidence**
   - file paths
   - line references
   - tool call ids
   - logs
   - screenshots/attachments
   - timestamps

8. **Impact / Risk**
   - user-visible impact
   - data-loss risk
   - reliability/security risk
   - workflow impact

9. **Root-Cause Hypotheses**
   - label as hypotheses, not facts
   - include confidence if possible
   - list what evidence would confirm/refute each hypothesis

10. **Workarounds**
    - known temporary mitigations
    - risks of each workaround
    - when not to use them

11. **Proposed Fix Direction**
    - recommended code-level or design-level fix
    - compatibility concerns
    - migration or behavior changes

12. **Acceptance Criteria**
    - objective tests that define done
    - regression checks
    - negative tests

13. **Open Questions**
    - missing info
    - decisions required
    - owner needed

14. **Next Session Checklist**
    - exact first files to read
    - exact commands/tests to run
    - expected first action

### Optional Sections

Add when relevant:

- Timeline
- Attachments
- Related issues / PRs
- Bisect notes
- Security considerations
- Data integrity notes
- Rollback plan
- Release note wording

### Output Rules

1. The report must be self-contained.
2. Filename must follow `<date><title>_issue.md`: `YYYYMMDD` + concise snake_case title + `_issue.md`.
3. Do not assume the next agent can read prior chat.
4. Include paths as absolute paths when they are handoff-critical.
5. Separate facts from hypotheses.
6. Include at least one reproduction path, even if approximate.
7. If evidence is compacted, include recallable tool call ids.
8. Do not overclaim root cause without verification.
9. End with a concrete next-session checklist.

## 11. Next Session Checklist

For the next session handling this issue:

1. Open this file:

```text
/home/pkcs12/projects/documents/issues/20260513_apply_patch_false_success_path_resolution_issue.md
```

2. Recall original session outputs if available:

```text
call_hiAVQej563UZFzNIFCbPIPAg
call_AenUODZFC1R1S6BYzLgDFUaH
call_V3rs0fn4yQnUyWDBwgXomqEw
call_drKLEE0lzGmFU8MvjSuKwzT2
```

3. Locate `apply_patch` implementation in the OpenCode repo.
4. Check how it resolves:
   - cwd-relative paths
   - `../` segments
   - symlinks
   - mounted paths
5. Add or run tests for:
   - successful real patch
   - no-op patch
   - hunk mismatch
   - symlink target
   - sibling path escape
6. Update the tool response schema to include mutation summary and resolved path metadata.
7. Re-run the original-style reproduction before closing.

---

## 12. Resolution Status

| Field | Value |
|---|---|
| Status | Resolved |
| Resolved date | 2026-05-13 |
| Fixed in repo | `/home/pkcs12/projects/opencode` |
| Primary files changed | `packages/opencode/src/tool/apply_patch.ts`, `packages/opencode/test/tool/apply_patch.test.ts` |

## 13. Final RCA

Confirmed root cause: `apply_patch` treated patch parsing and workflow completion as sufficient evidence for success, but the success contract did not explicitly prove that the intended target path was safe, unambiguous, and byte-mutated.

Hypothesis outcomes:

- **H1 confirmed**: no-op/effective-zero-change patches could reach the success-shaped path because the tool did not reject `oldContent === newContent` for update/add operations.
- **H2 partially confirmed**: tool output did not expose enough path-resolution evidence for a caller to compare requested path, normalized path, absolute path, and symlink-resolved realpath.
- **H3 confirmed as policy gap**: `../` path escape was not explicitly rejected at the tool boundary. The fix chooses fail-fast rejection rather than supporting sibling-workspace mutation.
- **H4 not fully reproduced against Google Drive**: mount/hardlink stale-read behavior was not re-created directly, but the fix adds realpath reporting for symlink-like ambiguity and rejects unsafe path forms.

A second live observation during this fix reinforced the report: an `apply_patch` call reported success against `packages/opencode/src/tool/apply_patch.ts`, while an immediate `read` initially showed stale content. The subsequent `git diff` and later reads showed the change did land, so this secondary observation is classified as tool/UI read-after-write inconsistency evidence, not a separate confirmed root cause.

## 14. Fix Implemented

Changed behavior in `packages/opencode/src/tool/apply_patch.ts`:

- Reject absolute patch paths with `must be relative`.
- Reject any normalized patch path containing `..` with `must not contain '..'`.
- Reject update/add patches that would not change file bytes with `patch would not change file`.
- Add per-file mutation evidence to metadata:
  - `requestedPath`
  - `normalizedPath`
  - `absolutePath`
  - `realPath`
  - `bytesBefore`
  - `bytesAfter`
  - move-path equivalents for rename patches

Changed tests in `packages/opencode/test/tool/apply_patch.test.ts`:

- Updated stale metadata expectations after the prior metadata-strip work.
- Added end-to-end regression coverage through `ApplyPatchTool.execute()` for:
  - absolute path rejection
  - `../` parent escape rejection
  - no-op update rejection
  - symlink path realpath reporting
  - normal add/update/delete behavior with mutation metadata

Compatibility notes:

- Existing successful relative workspace patches continue to work.
- Cross-workspace edits via `../` are now intentionally disallowed; callers must operate from the correct workspace or use an explicit approved external-directory workflow outside `apply_patch`.
- Metadata shape is additive relative to the metadata-strip state: it still omits `before`/`after` full file bodies.

## 15. Verification Results

Commands run from `/home/pkcs12/projects/opencode`:

```text
bun test packages/opencode/test/tool/apply_patch.test.ts
```

Result:

```text
31 pass
0 fail
89 expect() calls
```

Additional check:

```text
bun --check packages/opencode/src/tool/apply_patch.ts packages/opencode/test/tool/apply_patch.test.ts
```

Result: passed with no reported errors.

Whitespace check:

```text
git diff --check -- packages/opencode/src/tool/apply_patch.ts packages/opencode/test/tool/apply_patch.test.ts
```

Result: passed with no reported errors.

## 16. Follow-ups / Residual Risk

- Google Drive mount/hardlink behavior was not directly reproduced in this repo; the fix reduces ambiguity by exposing `realPath`, but a future environment-specific test may still be useful if Google Drive stale reads recur.
- The issue report also proposed a reusable `bug-report` skill. That skill was created at `/home/pkcs12/.local/share/opencode/skills/bug-report/SKILL.md` and now requires resolved reports to append RCA/fix/verification before moving to `issues/closed/`.
- No retroactive session DB migration is required for this fix.


## 17. Follow-up: Home/Sudoer Scope Relaxation

After the initial fix, the user clarified the desired policy: `apply_patch` should not be limited to repo-relative edits. The implemented policy is now:

- repo/worktree paths remain allowed;
- non-sudoer users may patch anywhere under the current user's home directory, including absolute paths and `..` paths that resolve inside home;
- root/sudoer users may patch anywhere on the filesystem;
- non-sudoer mode still rejects symlink/realpath escapes outside repo/worktree/home;
- NUL and empty paths still fail fast.

Additional verification:

```text
bun test packages/opencode/test/tool/apply_patch.test.ts
# 33 pass / 0 fail / 101 expect() calls

bun --check packages/opencode/src/tool/apply_patch.ts packages/opencode/test/tool/apply_patch.test.ts
# pass

git diff --check -- packages/opencode/src/tool/apply_patch.ts packages/opencode/test/tool/apply_patch.test.ts docs/events/event_20260513_apply-patch-issue.md issues/closed/20260513_apply_patch_false_success_path_resolution_issue.md
# pass
```

## 18. Follow-up: Runtime Reload and Tool Contract Synchronization

After the home/sudoer scope relaxation, the source code and tests were updated, but the live session initially still appeared to reject cross-repo/absolute `apply_patch` paths. The remaining gap was runtime synchronization rather than policy logic:

- `packages/opencode/src/tool/apply_patch.txt` still had to be synchronized from the old prompt contract (`NEVER ABSOLUTE`) to the new policy.
- `ApplyPatchTool` permission metadata had to stop sending cross-repo paths to the `edit` permission layer as opaque `../other-repo/...` patterns; it now sends absolute paths for home/global targets while preserving relative paths for in-worktree edits.
- The live daemon/tool layer needed a restart/reload before the updated tool implementation and prompt contract became visible to the current agent session.

Final follow-up verification:

```text
bun test packages/opencode/test/tool/apply_patch.test.ts
# 33 pass / 0 fail / 103 expect() calls

bun --check packages/opencode/src/tool/apply_patch.ts packages/opencode/test/tool/apply_patch.test.ts
# pass

git diff --check -- packages/opencode/src/tool/apply_patch.ts packages/opencode/src/tool/apply_patch.txt packages/opencode/test/tool/apply_patch.test.ts docs/events/event_20260513_apply-patch-issue.md
# pass
```

Runtime status:

- User confirmed opencode was restarted after the source fix.
- After restart, the active `apply_patch` tool contract showed the new policy: file references may be relative or absolute; non-sudoer sessions are limited to the current user's home directory; root/sudoer sessions may patch system-wide paths.
- No full system reboot is required; daemon/runtime reload is sufficient.

## 19. Regression: Same Issue Recurred

The issue recurred after this report had been marked resolved. Treat this closed report as the canonical history/RCA record, but not as proof that the behavior is fully fixed.

Active regression tracker:

- `issues/20260513_apply_patch_ok_but_no_effect_and_duplicate_patch.md`

Regression classification:

- Same issue family: `apply_patch` reports success/ok while the caller cannot reliably observe the expected file mutation afterward.
- The recurrence includes no-effect reads, duplicate patch confusion, and fallback to non-`apply_patch` writes for durable updates.
- The open regression tracker must remain open until it has fresh RCA, a fix that covers the recurrence mode, and post-fix verification.
