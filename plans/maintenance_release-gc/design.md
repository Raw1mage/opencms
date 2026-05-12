# Design: maintenance/release-gc

## Architecture

GC sweep 不引入新 runtime 行為；架構即「執行流程契約」：

```
Phase 0 (Discovery, dream-mode)
   ├─ per-category scanner produces evidence entries in tasks.md
   ├─ each evidence: { path:line | symbol, classification, SUSPECT? }
   └─ exit gate: user confirms taxonomy + evidence before Phase 1

Phase 1+ (Execution, per category)
   ├─ for each Cn in [C1..C7]:
   │    ├─ branch checkpoint = pre-Cn HEAD (so revert = git reset to checkpoint)
   │    ├─ apply removals (one logical commit per category)
   │    ├─ verify: bun typecheck + bun test + bun build (or repo equivalent)
   │    ├─ on failure: revert Cn commit; mark evidence as SUSPECT in tasks.md
   │    └─ on success: spec_record_event with commit SHA + evidence resolved
   └─ submodule pointer changes: separate commit per feedback_submodule_always_commit
```

## Decisions

- **DD-1**: Phase 0 (盤點) 與 Phase 1+ (執行) 嚴格分離；Phase 0 結束後必須與使用者 confirm 分類清單才開始任何 deletion。Why: 做夢模式 = slow scan，盤點/執行混合是誤刪溫床。
- **DD-2**: 每個分類 = 一個 atomic commit = 一個 revertible unit。不混 commit、不跨分類。Why: 「可追溯可逆」是使用者明確需求；單一 revert 必須能完整還原該分類。
- **DD-3**: Commit message 格式固定為 `chore(gc/<cN>): <action>`，body 列出 evidence path 與對應 tasks.md 條目編號。Why: release notes / 後續審查可直接 grep `chore(gc/`。
- **DD-4**: 不在此 plan 內做 lifecycle 提升 (proposed → designed)；GC sweep 是輕量維運工作，強制走 IDEF0/GRAFCET 不划算。spec 永遠停在 proposed，完成後直接 `plan_archive`（或視 release 後再決定要不要 graduate 留作 KB 範本）。Why: plan-builder §12.1 已明示輕量場景可豁免 c4/idef0 投資。
- **DD-5**: knip / ts-prune 設定必須先把 entry points 全列齊（packages/opencode CLI、TUI、admin webapp、plugin loader、MCP servers），未列齊前不執行 C1 刪除。Why: false positive 的成本（誤刪 lazy load）高於 false negative。
- **DD-6**: SUSPECT 標記是 first-class status——盤點階段任何「看似死但不確定」的 evidence 必須標 SUSPECT，Phase 1 預設**不**處理 SUSPECT，留給人工審查。Why: 自動化的 reach 分析在 multi-entry monorepo 一定有盲區。
- **DD-7**: 驗證指令以實際 repo 內 package.json scripts 為準（Phase 0 階段確認後寫入此 design.md §Verification）。Why: 避免假設 `bun test` 存在而誤判失敗。

## Verification (confirmed P0.0, 2026-05-12)

- typecheck: `bun run typecheck` (= `bun turbo typecheck`)
- test: `bun run test` (= `bun scripts/test-with-baseline.ts`)
- build: `bun run build` (= `bun run script/build.ts`)
- lint: `bun run lint` (eslint, optional gate)
- knip: not installed; use `bunx knip` after P0.1 config setup
- Repo: bun workspaces + turbo; 22 packages under `packages/*` + `packages/mcp/*` + `packages/console/*`

## Code Anchors

- (none yet — populated as evidence accumulates in tasks.md)

## Risk Register

| Risk | Mitigation |
|---|---|
| knip false positive 誤刪 lazy import | DD-5 entry points 齊全 + DD-6 SUSPECT 保留 |
| 跨 package consumer 在 admin webapp | knip 設定要把 webapp 視為獨立 entry |
| Superseded feature 仍有 runtime fallback path | C3 每條 evidence 必須 grep 雙向確認無 consumer |
| Submodule pointer 漂移污染 GC commit | DD-3 + feedback_submodule_always_commit 強制單獨 commit |
| 中斷後續會 lost context | spec_record_event 每完成一類就寫；做夢模式 resume 友善 |
