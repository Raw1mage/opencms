# 2026-05-07 Claude Import Anchor / Provider Switch Contamination

## 需求

- 使用者指出目前 session 前文與 drawmiat / diagram regeneration 無關，但 compact 後模型接續到 Claude import 的 takeover anchor，誤把舊 Claude 工作的 `commit` 當作當前任務。
- 需要修復 Claude import anchor 與 provider-switch compaction 的邊界，避免 imported handoff 污染 live session。

## 範圍 (IN/OUT)

- IN:
  - `packages/opencode/src/session/prompt.ts` provider-switch pre-loop compaction 行為。
  - Claude takeover anchor 後已有新 live user turn 時的 anchor reuse 判斷。
  - 聚焦 regression test 與架構文件同步。
- OUT:
  - 不刪除既有 session / import metadata。
  - 不重啟 daemon / gateway。
  - 不還原 XDG 或 git history。

## Debug Checkpoints

### Baseline

- Session: `ses_1fde3b9f6ffeGLz88Qm5cOgr9V`，title 為 `Debug Codex unusual behavior and spinning issue`。
- Symptom: compact 後模型讀到 `Claude Takeover Anchor`，其中 `Current User Intent` 為 `line 1352: commit`，導致 assistant 執行 `docs(specs): retry grafcet diagram regeneration` commit。

### Instrumentation Plan

- 檢查 `system-manager_get_session` session metadata。
- 讀 `claude-import.ts` takeover anchor 寫入邏輯。
- 讀 `MessageV2.filterCompacted` 與 `prompt.ts` provider-switch pre-loop anchor reuse 邏輯。
- 透過 `system-manager_read_subsession` 讀當前 session stream，確認 compaction anchor 與 synthetic continuation 寫入順序。

### Execution / Evidence

- `~/.local/share/opencode/storage/session_import/.../d40c0ff7-186f-4ac2-8a81-1f9b3e9e4713.json` 指向 `sessionID: ses_1fde3b9f6ffeGLz88Qm5cOgr9V`，並記錄 takeover anchor metadata。
- 當前 session stream 顯示 `retry` user turn 後，`prompt.ts` provider-switch path 寫入新的 `agent=compaction` / `summary=true` assistant message，text 為 Claude takeover anchor，並附 `type=compaction auto=true`。
- 同一 compaction 後立刻寫入 synthetic user message：`Compaction completed. Continue from your existing plan...`。
- 後續 assistant 因此依照 imported handoff 做 diagram regeneration commit。

### Root Cause

1. Claude import large transcript 會寫 `summary:true` + `compaction` part 的 takeover anchor。
2. Provider-switch pre-loop 把最近 stream anchor 視為通用 snapshot 來源。
3. 該路徑未區分 `metadata.takeoverAnchor`，也未檢查 anchor 後是否已有新的 live user turn。
4. Provider-switch compaction 呼叫 `compactWithSharedContext({ auto:true })`，繞過原本 `provider-switched` 不注入 Continue 的設計意圖。
5. 新 compaction anchor + synthetic continue 讓模型把舊 Claude handoff 當成當前任務。

### Validation

- 新增 regression: `does not reuse stale Claude takeover anchor after a new user turn`。
- 聚焦測試：`OPENCODE_SERVER_PASSWORD= bun test --timeout 15000 packages/opencode/test/server/session-list.test.ts` → 16 pass / 96 expects。
- Architecture Sync: Updated `specs/architecture.md` Tool Surface Runtime section to record provider-switch recovery's takeover-anchor freshness guard and non-continuing provider-switch compaction.

## 變更

- `packages/opencode/src/session/prompt.ts`
  - 新增 `shouldReuseProviderSwitchAnchor` helper。
  - 若最近 anchor 是 Claude takeover anchor 且 anchor 後已有 live user message，provider-switch snapshot 不重用該 anchor text。
  - provider-switch pre-loop compaction 改為 `auto:false`，避免防禦性 rebind 注入 synthetic continue。
- `packages/opencode/test/server/session-list.test.ts`
  - 新增 takeover anchor freshness regression。
- `specs/architecture.md`
  - 補充 Claude takeover anchor / provider-switch recovery 邊界。
- `specs/diagrams/`
  - 依使用者指令「刪光再重繪」，清空 centralized diagram mirror 後，以現行 14 份 `specs/*/grafcet.json` 重新產出 canonical `<slug>.svg` 與 `grafcet-regeneration-report.json`。
  - `plan-builder-sample.svg` 因不屬於現行 `specs/*/grafcet.json` 來源集合而未重建。

## Diagram Redraw Validation

- Regeneration result: `14 total / 14 ok / 14 written / 0 warnings / 0 errors`。
- XML parse: `xml_ok=14`。
- Output set: `account.svg`, `agent-runtime.svg`, `app-market.svg`, `attachments.svg`, `autonomous-opt-in.svg`, `codex-empty-turn-recovery.svg`, `compaction.svg`, `daemon.svg`, `grafcet-renderer-overhaul.svg`, `mcp.svg`, `meta.svg`, `provider.svg`, `session.svg`, `webapp.svg` plus `grafcet-regeneration-report.json`。

## XDG Backup

- `/home/pkcs12/.config/opencode.bak-20260507-1922-claude-import-anchor-provider-switch/`
- 這是 plan 起跑前的白名單快照，僅供需要時手動還原；本次未自動 restore。
