# Plan: Fix and Optimize Session Storage Listing

## Problem
1. **Performance**: `Storage.list(["session"])` currently performs O(N) directory scans and file existence checks. If filtered by projectID, it performs O(N) full `info.json` reads.
2. **Potential Bug**: Migration 3 erroneously migrates sessions to `session/<projectID>/<sessionID>/info.json`, which conflicts with the expected system path `session/<sessionID>/info.json`.
3. **Inconsistency**: Listing relies on directory scanning while a dedicated index directory exists but is not fully utilized.

## Proposed Changes

### 1. Fix Migration 3 in `packages/opencode/src/storage/storage.ts`
- Change destination of session migration to be flat under `session/`, i.e., `storage/session/<sessionID>/info.json`.

### 2. Add Migration 4 for Index Backfill
- Scan `storage/session/*` directories.
- For each directory containing `info.json`, read its `projectID`.
- Ensure `index/session/<sessionID>.json` is written.

### 3. Optimize `Storage.list(["session"])`
- Primary source: Scan `index/session/` directory.
- If `prefix[1]` (projectID) is provided:
  - Read the small index files in `index/session/` to filter.
- Fallback: If `index/session/` is empty or missing, scan `session/` and perform backfill.

### 4. Cleanup
- Remove the diagnostic script `debug_sessions.ts`.

## Verification Plan
1. Run the modified `Storage.list` logic via a test script.
2. Verify that all 239 sessions are still found.
3. Verify that the performance is improved for filtered listings.
