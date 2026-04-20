# Handoff: session-ui-freshness

Executor 契約——build agent 進入 `implementing` 時必讀。

---

## Execution Contract

- **單線執行為主**：本 plan 是 frontend-dominant + 少量 daemon config；除 Phase 4 grep audit 可選擇 spawn `Explore` subagent 外，其餘 phase 單 agent 執行。
- **Phase 順序**：嚴格 1 → 2 → 3 → 4 → 5，不跳序。Phase 2 的 useFreshnessClock 與 tweaks signals 是 Phase 3 的必要前件；Phase 3 之前 Phase 4 的刪除若先做會踩到 Phase 3 的 render 修改衝突。
- **每個 phase 結束**：寫 phase summary 進 `docs/events/event_2026-04-21_session_ui_freshness_implementation.md`（Phase 1 的 1.5 task 建檔），然後 **immediately** 跑 next-phase TodoWrite rollover + 接下一 phase 的第一個 task（plan-builder §16.1 / §16.5）。不等使用者核准。
- **每 task 結束**：勾 `- [x]` → 跑 `bun run /home/pkcs12/projects/skills/plan-builder/scripts/plan-sync.ts specs/session-ui-freshness/` → 讀 drift warning → 依 decision tree 處理（plan-builder §16.3）。
- **Beta worktree 適用**：Frontend 改動 + 觸及多個 session-scoped path，建議走 beta-workflow：在 `beta/session-ui-freshness` 分支 + `opencode-beta` worktree 實作；最後 merge 回 main。Daemon 配置改動（Phase 2 的 tweaks.ts / routes/config.ts）屬 backend 面，但影響範圍小、不阻擋 beta 路線。
- **XDG 備份**：按 opencode AGENTS.md 規定，實作第一個程式碼編輯前必須快照 `~/.config/opencode/` 與相關 state（I-7 hotfix 已減風險，但規定仍生效）。

## Required Reads

實作前必讀：

1. `specs/session-ui-freshness/proposal.md` — scope / constraints / effective requirements
2. `specs/session-ui-freshness/spec.md` — R1–R6 + 12 scenarios（GIVEN/WHEN/THEN 為 acceptance source of truth）
3. `specs/session-ui-freshness/design.md` — **DD-1 ~ DD-8 全部**；特別是 DD-6（connectionStatus 徹底刪）、DD-4（no silent fallback）、DD-5（feature flag 語義）
4. `specs/session-ui-freshness/data-schema.json` — store entry shape 契約（尤其 `ClientStampMeta` intersection）
5. `specs/session-ui-freshness/c4.json` — component 清單（Phase 任務直接對到 C1.x / C2.x）
6. `specs/session-ui-freshness/idef0.json` + `grafcet.json` — A0-A5 功能拆分 + 4-state freshness 機
7. `specs/session-ui-freshness/test-vectors.json` — 自動化測試的具體 I/O fixture
8. `specs/session-ui-freshness/errors.md` — error code 契約
9. `specs/session-ui-freshness/observability.md` — metrics / logs naming
10. `docs/events/event_2026-04-20_frontend_oom_rca.md`（I-4 段）— 為什麼要重做 + 不可走回 `2fa1b0b2d` 方向
11. Git diff `2fa1b0b2d~1..2fa1b0b2d` — 對照要確認徹底清除的 code（只當 reference，不當實作依據）

背景輔助（非必讀但有用）：

- `packages/app/src/context/global-sync/event-reducer.ts`（理解 reducer 結構）
- `packages/app/src/context/frontend-tweaks.ts`（既有 tweaks infra，Phase 2 複用）
- `packages/opencode/src/config/tweaks.ts`（既有 tweak parser infra）

## Stop Gates In Force

Build 過程中，遇到下列情境**必須停下**並要求使用者決策（plan-builder §16.5）：

| Stop trigger | 原因 |
|---|---|
| `specs/architecture.md` 需要大幅改寫（不只 append 一段） | 動到全域架構 SSOT，需要人工審視 |
| Rollout flag 是否移除 | DD-5 約定「測試通過即退場」；由使用者在 acceptance 後觸發 `amend` mode，不由 build agent 自作主張 |
| 發現 scope 外的 bug（例如 SSE reconnect 本身壞了） | 寫進 event log，問使用者是否另起 plan，不 in-place 修 |
| Drift warning 暗示需 `extend` / `refactor` mode | 停 phase，引用 plan-sync 輸出讓使用者選 mode |
| 實作發現必須動 server event payload shape | 違反 design.md 「API 契約完全不動」；重新設計前停工 |
| 任何 destructive shell 操作 | 遵守 AGENTS.md「careful actions」規則 |

非 stop gates（照流程執行）：

- 完成某個 phase → 自動進下一 phase，不問
- Sync warned 但 drift 只在當前 spec 內 → 照 decision tree 在 phase 邊界處理
- typecheck 或 test 失敗 → 自我修復，不問（連續失敗才回報）

## Execution-Ready Checklist

進 `implementing` 前確認：

- [ ] `~/.config/opencode.bak-YYYYMMDD-HHMM-session-ui-freshness/` 已建立
- [ ] 相關 `~/.local/state/opencode/` / `~/.local/share/opencode/` 已備份（若實作會觸及 state/data）
- [ ] beta-workflow admission gate 已評（若要走 beta worktree）
- [ ] `bun test` 在 NODE_ENV=test 下會走 `/tmp/opencode-test-<pid>/`（I-7 hotfix，commit `abf793084`）
- [ ] `plan-validate.ts` 在 `planned` state PASS（本 handoff 存在即代表此條達成）
- [ ] 已確認 `git status` 乾淨（或 WIP 是預期內、被 stash）
- [ ] TodoWrite 狀態為空（或已確認未完工項目可以中斷）
- [ ] Phase 1 的 1.5 task 會建 `docs/events/event_2026-04-21_session_ui_freshness_implementation.md`

## Phase Summary Expectations

每 phase 結束寫入 event log（plan-builder §16.4）。最低欄位：

```markdown
## Phase <N>: <phase name>

- **Done tasks**: 1.1, 1.2, 1.3, 1.4, 1.5
- **Key decisions**: <新增或調整的 DD-N；若只是依設計執行則 "no new decisions">
- **Validation**: `bun test packages/app/test/event-reducer-freshness.test.ts` → 4 pass / 0 fail；typecheck clean；handbuilt repro 通過
- **Drift**: <列 plan-sync 的 warn 或 "no drift">
- **Remaining**: Phase <N+1> 起手（task IDs）
```

## Post-Merge

實作完成、acceptance pass 之後：

1. Phase 5 的 5.6 task 執行 `plan-promote.ts specs/session-ui-freshness/ --to verified`，reason 含：
   - 所有 test 結果（pass 數 / fail 數）
   - Manual 驗收 checklist 完成度
   - Feature flag 在生產預設值
2. 若走 beta-workflow，fetch-back 到 main 之後立刻刪 `beta/session-ui-freshness` + `test/session-ui-freshness` 分支（AGENTS.md 規定；worktree 目錄保留）。
3. 使用者驗證瀏覽器實際行為後：
   - 通過 → `plan-promote.ts --to living`
   - 發現 regression → `plan-promote.ts --mode amend` 或整塊 revert + 開 follow-up plan
4. Flag retirement trigger（DD-5 + 使用者 2026-04-20 拍板）：當 R1–R6 的 automated acceptance 與手動驗收都綠 → 使用者觸發 `amend` mode，移除 `ui_session_freshness_enabled` flag 與相關 dead code。
5. 相關 follow-up plan（獨立，不在本 plan scope）：
   - `gateway-sse-heartbeat` — gateway 送 `:\n\n` keepalive + `retry:` field
   - `daemon-session-status-heartbeat` — server 定期 re-emit session.status
   - `client-server-version-handshake` — 對應 RCA I-9
