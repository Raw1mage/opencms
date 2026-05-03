# Handoff: prompt-cache-and-compaction-hardening

## Execution Contract

| Field | Value |
|---|---|
| `mainRepo` | `/home/pkcs12/projects/opencode` |
| `baseBranch` | `main` |
| `implementationWorktree` | `/home/pkcs12/projects/opencode-worktrees/prompt-cache-hardening` |
| `implementationBranch` | `beta/prompt-cache-hardening` |
| `docsWriteRepo` | `/home/pkcs12/projects/opencode` (= mainRepo) |
| `featureSlug` | `prompt-cache-hardening` |

## Required Reads

(Read every file in this section before any code change.)

- [proposal.md](./proposal.md) — Why + scope + breakpoint allocation strategy
- [spec.md](./spec.md) — R1~R7 GIVEN/WHEN/THEN
- [design.md](./design.md) — DD-1..DD-14（DD-1/DD-2 是使用者鎖定的設計，**不要動**）
- [c4.json](./c4.json) — 11 個 component 與責任邊界
- [sequence.json](./sequence.json) — 6 個關鍵 scenario 對應 R1~R7
- [data-schema.json](./data-schema.json) — 12 個 contract，新增 type 必須對齊
- [tasks.md](./tasks.md) — 兩 Phase 的 task 樹
- 上游相依：[compaction-redesign/design.md](../compaction-redesign/) (DD 鎖定不可破壞)、[session-rebind-capability-refresh/design.md](../session-rebind-capability-refresh/) (RebindEpoch + CapabilityLayer 既有契約)
- 風險記憶：
  - [feedback_beta_xdg_isolation.md](../../.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_beta_xdg_isolation.md) — 必須 source `.beta-env/activate.sh` 後才跑 bun test
  - [feedback_no_silent_fallback.md](../../.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_no_silent_fallback.md) — DD-8 hard-fail 的根據
  - [feedback_minimal_fix_then_stop.md](../../.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_minimal_fix_then_stop.md) — Phase A 各 task 各自最小修；不要藉機改架構

## Beta Surface Setup

每次進 beta worktree 跑指令前：

```bash
cd /home/pkcs12/projects/opencode-worktrees/prompt-cache-hardening
source .beta-env/activate.sh   # 必跑！否則 bun test 會踩 ~/.config/opencode/accounts.json
```

驗證：`echo $XDG_CONFIG_HOME` 必須印 `/home/pkcs12/projects/opencode-worktrees/prompt-cache-hardening/.beta-env/xdg-config`。

## Stop Gates In Force

| Gate | When | What to do |
|---|---|---|
| **Phase A complete** (tasks.md §6.7) | 5 個 sub-phase 全綠、6.5 拉 main 無衝突、6.6 fetch-back test branch 全綠 | STOP；報告給使用者，等 finalize 批准 |
| **Phase B start** | tasks.md §8 之前 | STOP；除非使用者明確說「進 Phase B」否則不要動 |
| **B.11 default-on flag** | dogfood 一週後 | STOP；報告 telemetry 數字，等使用者批准把 `OPENCODE_PROMPT_PREFACE` 預設轉 1 |
| **conflict / red test** | tasks.md 6.5 / 6.6 / 任何 unit test | STOP；不要 force resolve，回報衝突細節 |
| **DD-1 / DD-2 想改** | 任何時候 | STOP；DD-1/DD-2 是使用者已鎖的設計，要動須重啟對話確認 |
| **超出 spec scope 的 refactor 衝動** | 看到隔壁碼怪怪的 | STOP；記到 `discoveries`，不要順便重構（[feedback_minimal_fix_then_stop](../../.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_minimal_fix_then_stop.md)） |

## Per-task Ritual (per [plan-builder §16.3](../../../../skills/plan-builder/SKILL.md#163-per-task-ritual))

每完成一個 tasks.md item：

1. 在 mainRepo 把該 item 從 `- [ ]` 改成 `- [x]`
2. 跑 `bun run /home/pkcs12/.claude/skills/plan-builder/scripts/plan-sync.ts specs/prompt-cache-and-compaction-hardening/`
3. 讀 sync 輸出
   - clean → 繼續
   - warned → 看 drift 性質，按 [plan-builder §16.3 decision tree](../../../../skills/plan-builder/SKILL.md#163-per-task-ritual) 處理（可能是 amend / extend / refactor）
4. TodoWrite 對應 item 改 `completed`

## Phase Boundary Ritual (per plan-builder §16.4)

完成 §1-§5 任一 phase 時，在 mainRepo 寫 `docs/events/event_<YYYYMMDD>_<phase-name>.md`，欄位：

- Phase 名稱與 task ids
- 這個 phase 落地的 commits
- 新加的 DD 或 spec 修訂（理論上 Phase A 不該動 DD，若有就是出狀況）
- Validation 結果（test 通過數、typecheck、煙霧測試結果）
- 任何 sync 警告與處理
- 下一個 phase 的進入條件

## Execution-Ready Checklist

- [x] mainRepo + baseBranch 已確認
- [x] beta worktree 建立 + XDG isolation 啟動腳本就緒
- [x] tasks.md 寫好 + phase 拆分明確
- [x] handoff.md（本檔）就緒
- [ ] test-vectors.json 寫好
- [ ] errors.md 寫好
- [ ] observability.md 寫好
- [ ] spec promote 到 `planned`

## Branch / Worktree Discipline

- 所有 code change 在 `/home/pkcs12/projects/opencode-worktrees/prompt-cache-hardening` 上做
- 所有 spec / docs change 在 mainRepo 做（`/specs/` 與 `docs/events/`）
- **不要** 在 beta worktree 改 `/specs/`
- **不要** 在 mainRepo 改 `packages/`（除非 finalize 階段的 merge）
- commit message 用 conventional commits；feat/fix/chore 等
- commit 不簽署 hook bypass（無 `--no-verify`）
- 不直接 push beta 分支到遠端（本地驗證即可，fetch-back 走本地 worktree）

## Rollback Plan

- Phase A 各 task 都是獨立 commit；個別 revert 即可（DD-6/7/8/9/10 之間正交）
- Phase B 整體靠 `OPENCODE_PROMPT_PREFACE=0` flag 關閉；極端情況 revert 整段 Phase B commits

## Post-Merge Spec Closeout

Phase A 合 main 後：
- spec 暫不轉 `living`（Phase B 還沒做）
- 若使用者決定不做 Phase B：用 `plan-promote --mode amend --reason "Phase B descoped, only A landed"` 收斂 design.md，然後再轉 `living`

Phase B 合 main 後：
- spec 整體轉 `living` via `plan-promote --to verified` → `--to living`
- docs/prompt_injection.md 改寫；新檔 docs/prompt_dynamic_context.md
