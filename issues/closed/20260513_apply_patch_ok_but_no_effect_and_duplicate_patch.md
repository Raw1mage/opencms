# Bug Report: apply_patch reports success but file reads unchanged / duplicate patch confusion

Status: Closed

Canonical issue: `issues/closed/20260513_apply_patch_false_success_path_resolution_issue.md`

Regression note: This recurrence now has its own RCA, fix, and post-fix verification. Closed after runtime reload/self-restart validation made the updated tool implementation available.

## 0. Handoff Summary

During a drawmiat plan implementation session, `apply_patch` repeatedly produced confusing behavior while editing Markdown checklist/event files. In several cases the tool returned `ok`, but an immediate follow-up read showed the target file unchanged or missing the expected insertion. In other cases repeated patch attempts appeared to create duplicate insertions or required a fallback full-file rewrite / Python file write to make the change durable.

This issue is intentionally detailed so a separate debug agent can investigate the patch tool/runtime behavior without reconstructing the whole drawmiat session.

## 1. Context

- Active repo/session cwd: `/home/pkcs12/projects/drawmiat`
- External issue repo: `/home/pkcs12/projects/opencode`
- Date: 2026-05-13
- Main work underway:
  - `plans/mcp_output-solution-artifacts`
  - `plans/grafcet_validator-compliance-audit`
- Files where symptoms were observed most clearly:
  - `/home/pkcs12/projects/drawmiat/plans/mcp_output-solution-artifacts/tasks.md`
  - `/home/pkcs12/projects/drawmiat/docs/events/event_20260513_mcp_output_solution_artifacts.md`
  - `/home/pkcs12/projects/drawmiat/plans/grafcet_validator-compliance-audit/tasks.md`
  - `/home/pkcs12/projects/drawmiat/docs/events/event_20260513_grafcet_validator_compliance_audit_plan.md`

## 2. Observed Symptoms

### 2.1 `apply_patch` returned ok, but immediate read did not show the change

Multiple patches against Markdown checklist/event files returned `ok`. Immediately after, `read` showed the old content still present or showed that the newly inserted lines were absent.

Examples from the session narrative:

- Updating MCP event architecture sync:
  - `apply_patch` attempted to add an architecture-sync bullet to `docs/events/event_20260513_mcp_output_solution_artifacts.md`.
  - Tool returned `ok`.
  - Follow-up `read` did not show the expected addition, so the patch was retried.

- Updating Grafcet event downstream evidence:
  - `apply_patch` attempted to insert downstream audit evidence into `docs/events/event_20260513_grafcet_validator_compliance_audit_plan.md`.
  - Tool returned `ok`.
  - Follow-up read did not clearly reflect the insertion, requiring another edit attempt.

- Updating MCP tasks checklist:
  - Several attempts to flip items from `[ ]` to `[x]` returned `ok`.
  - Follow-up reads showed the checklist still in an older state.
  - Eventually the agent used Python file writes to replace checklist lines because the patch/read loop was not trustworthy.

### 2.2 Repeated patch attempts sometimes produced duplicate insertions or ambiguity

Because the first `ok` result could not be trusted, the agent retried patches. In at least one event file this produced duplicate architecture-sync bullets that later had to be cleaned up.

This makes the failure mode especially risky: the caller cannot tell whether `ok` means:

1. Patch applied and read is stale;
2. Patch did not apply but tool returned ok;
3. Patch applied once, retry then applied again;
4. Patch applied to a different layer/path than the subsequent read observes.

### 2.3 Full-file rewrite via `apply_patch` also appeared unreliable for one untracked plan checklist

For `plans/mcp_output-solution-artifacts/tasks.md`, the agent attempted a delete/add full-file rewrite through `apply_patch` to avoid hunk ambiguity. The tool returned `ok`, but later inspection still showed stale or unexpected checklist state. The agent then used a Python write and printed the file with Python to confirm the actual contents.

This suggests the issue may not be limited to hunk matching.

### 2.4 External absolute path behavior changed after capability refresh

Earlier in the session, `apply_patch` rejected external paths:

- `../opencode/...` -> rejected because `..` not allowed.
- `/home/pkcs12/projects/opencode/...` -> rejected because path had to be relative.

After tool/capability refresh, the same style of absolute path worked:

- Added `/home/pkcs12/projects/opencode/issues/_apply_patch_external_probe.md` successfully.
- Read confirmed the probe file existed.
- Deleted the same absolute-path file successfully.

This may be a separate capability-layer/versioning issue, but it contributed to confusion while diagnosing patch behavior.

## 3. Approximate Timeline

1. Agent edited Grafcet plan artifacts with `apply_patch`.
2. User questioned whether patch tool had a bug.
3. Agent acknowledged some earlier misuse: parallel/duplicate patch attempts and stale context were possible.
4. Later, during MCP/Grafcet final sync, the same pattern recurred under stricter read-before-patch flow:
   - read target file;
   - apply_patch returned `ok`;
   - read target file again;
   - expected change missing or file state surprising.
5. Agent used repeated patch attempts, delete/add full rewrites, and eventually Python writes for checklist synchronization.
6. Final session state includes successful work, but the patch tool behavior remained untrustworthy enough that a dedicated issue is needed.

## 4. Concrete Reproduction Shape

The exact stateful reproduction may require the original session, but a minimal investigation should test:

1. Create or use an untracked Markdown file under a repo, e.g. `plans/example/tasks.md`.
2. Read it using the file read tool.
3. Apply a small checklist replacement:
   ```diff
   - [ ] Example item
   + [x] Example item
   ```
4. Immediately read it again using the same read tool.
5. Compare:
   - apply_patch output;
   - filesystem content from an independent reader;
   - read-tool content;
   - git diff.
6. Repeat with:
   - tracked file;
   - untracked file;
   - Markdown file under `/plans/`;
   - event file under `/docs/events/`;
   - absolute path outside current repo.

## 5. Expected Behavior

- If `apply_patch` returns success, subsequent reads of the same path should reflect the change immediately.
- If the patch is a no-op, already applied, or failed to match, the tool should report that explicitly.
- The tool should not return ambiguous success when no filesystem mutation occurred.
- If read cache/staleness is involved, the read result should be invalidated after successful mutation.

## 6. Actual Behavior

- `apply_patch` sometimes returned `ok` while follow-up reads did not show the expected mutation.
- Retrying the same patch could either still appear ineffective or create duplicate insertions.
- The agent had to fall back to Python writes and Python-based file printing to confirm actual content.

## 7. Impact

- Checklist truth drift: plan `tasks.md` could show stale status despite completed implementation.
- Event log drift: architecture/validation evidence could be missing or duplicated.
- Agent wastes context and tool calls retrying patches.
- User trust drops because the agent gives conflicting statements about whether a file changed.
- Risk of committing incorrect docs/checklists if final verification trusts tool `ok` output alone.

## 8. Evidence Pointers From Session Narrative

Representative tool-call ids available in the compacted narrative/tool index:

- MCP event repeated patch/read area:
  - `call_9asPk0UlODQnMuxYi0OKY5C0`
  - `call_vIgIHBEOzx75i2A4CnWH4S2C`
  - `call_YlTYYU94K4LZA0CL6iYVle2y`
  - `call_kOBbAFHJUWggxYDo6zeor0Pq`
- Grafcet task/event repeated patch area:
  - `call_vTB2n50504LuT82W3HWAb5BV`
  - `call_MuaRJN6hQRsK1ZBEEf0hQnX3`
  - `call_sfDGCDDi5bvjSerKYdga9KiL`
  - `call_paj1JSr3vl42fxMvxU6dMjc3`
- MCP tasks full rewrite / fallback area:
  - `call_mOYSJYjW56Tp27u9lIpuhFO2`
  - `call_McOJNYimdYV7SdK9QHBvpXay`
  - `call_gz0AqYgIhnUvfVlvAXl8pATU`
- External absolute path probe after refresh:
  - `call_HM6Sdvv3VNlvD9oGfoScp448`
  - `call_k4ZDwUUWGSm94gFl78AqjniN`
  - `call_WDLCWFWQpkPNxhEVlRAdiMaS`

The debug agent should use `recall(tool_call_id)` where available, rather than relying only on this summary.

## 9. Open Questions

- Is `apply_patch` mutating the filesystem but the read tool serving stale cached content?
- Is `apply_patch` returning success for no-op or failed hunks?
- Does behavior differ for untracked files vs tracked files?
- Does behavior differ after capability-layer refresh or tool version refresh?
- Are parallel duplicate tool calls being issued by the frontend/runtime, causing apparent duplicate patch attempts?
- Are absolute external-path writes routed through a different policy layer than relative repo writes?

## 10. Acceptance Criteria

- A successful `apply_patch` invalidates any read cache for mutated paths.
- A no-op patch reports `no_change` or equivalent, not plain success.
- A failed hunk reports a clear mismatch error.
- Duplicate application is detectable or idempotent enough to avoid repeated inserted bullets.
- External absolute-path support has one documented, stable behavior after tool refresh.
- Regression test covers read -> apply_patch -> read for tracked, untracked, and external absolute files.

## 11. RCA / Fix Update

Status: Fixed pending runtime reload

### RCA

The recurrence is the same issue family as the canonical false-success report, but the remaining gap is more specific: `apply_patch` performed filesystem writes and returned success without a mandatory post-write read-back verification step. That meant the success contract did not independently prove that the target path contained the expected bytes after `fs.writeFile` / `fs.unlink` completed.

When the caller then saw stale or surprising content through a subsequent `read`, there was no authoritative mutation proof in the `apply_patch` result to distinguish between:

1. filesystem mutation failure;
2. stale read/tool output;
3. repeated retry applying a second insertion;
4. path-layer mismatch.

### Fix

- Added post-write verification for every mutation before returning success:
  - add/update: read the target back and compare exact UTF-8 contents;
  - move: verify destination contents and source deletion;
  - delete: verify the source no longer exists.
- Added per-file verification metadata:
  - `sha256Before`
  - `sha256After`
  - `verified`
- Preserved prior safeguards:
  - no-op patches fail fast;
  - cross-repo/home/global edit permission paths use absolute paths;
  - `apply_patch.txt` allows relative or absolute paths under the active scope policy.

### Verification

```text
bun test packages/opencode/test/tool/apply_patch.test.ts
# 34 pass / 0 fail / 110 expect() calls

bun --check packages/opencode/src/tool/apply_patch.ts packages/opencode/test/tool/apply_patch.test.ts
# pass

git diff --check -- packages/opencode/src/tool/apply_patch.ts packages/opencode/src/tool/apply_patch.txt packages/opencode/test/tool/apply_patch.test.ts issues/20260513_apply_patch_ok_but_no_effect_and_duplicate_patch.md issues/closed/20260513_apply_patch_false_success_path_resolution_issue.md docs/events/event_20260513_apply-patch-issue.md
# pass
```

New regression coverage includes `read -> apply_patch -> read` for tracked Markdown under `docs/events/` and untracked Markdown under `plans/`, plus verification metadata checks.

### Closure

Closed 2026-05-21 after source verification and subsequent runtime self-restart validation. The issue is archived under `issues/closed/`.
