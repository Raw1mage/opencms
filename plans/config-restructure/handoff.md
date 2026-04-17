# Handoff

## Execution Contract

- Build agent 必須先讀 `implementation-spec.md`
- Build agent 必須讀 `proposal.md` / `spec.md` / `design.md` / `tasks.md`，並讀 `specs/architecture.md` 以掌握現行 config subsystem 結構
- Runtime todo 必須從 `tasks.md` 材料化，不得自編平行 checklist
- Build agent 不得只憑對話記憶恢復工作 — 本 plan package 為執行合約的唯一來源
- User-visible 進度與決策 prompt 須重用 planner-derived todo 命名

## Required Reads

- `proposal.md`（含 Original Requirement Wording、Revision History、Effective Requirement Description）
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`
- `../../specs/architecture.md`

## Current State

- Plan 已完成並驗證（2026-04-17 rev2）
- 四個開放問題使用者已決策：Scope 全部三個 Phase／LKG 路徑 `$XDG_STATE_HOME/opencode/config-lkg.json`／Override `providers.json`／Webapp 只修 `/global/config`
- MCP lifecycle 已驗證為 lazy（首次 message 才連線），Phase 3 不需 preflight
- **Phase 1 DONE**（2026-04-17 beta commit b121eeb28）：JsonError 瘦身、LKG snapshot、503 結構化回應、webapp ErrorBoundary、62+9 tests 全過、`docs/events/event_2026-04-17_config_crash.md` 已留痕
- **Phase 2 DONE**（2026-04-17 同日）：availability API + migration script + daemon log.info。design.md DD-8 記錄：runtime 行為不變，只交付 API + 一次性清理，避免中央過濾點的 regression 風險。62+9+5 tests 全過、對 main 無新增 failure
- **Phase 3 尚未動工**；Phase 1+2 已 commit 在 beta/config-restructure，等待 fetch-back / merge 決策

## Stop Gates In Force

- **Phase 1 完成前不得進 Phase 3**（Phase 3 section 隔離依賴 Phase 1 的 lkg 機制）
- **Webapp audit 未完成不得修 webapp 檔** — 先 grep `/global/config` 與 `innerText` 再改
- **Template drift** — Phase 3 若未同步 `templates/**`，不得標記 Phase 3 完成
- **Migration 腳本** — 執行前必須支援 `--dry-run`，使用者確認 diff 後才寫回
- **向後相容 regression** — 舊單檔 `opencode.json` 讀取能力若破壞必須回滾
- **Scope creep** — 若遇需重寫 `Config` namespace loader 的場景，停下回 planner
- **AGENTS.md 第一條** — 任何 fallback 未明確 log.warn/log.info 即為違規

## Build Entry Recommendation

- 從 `tasks.md` 1.1（audit webapp）開始，其為 Phase 1 其他任務的 precondition
- 平行可做 1.2（`JsonError` 瘦身），因其不依賴 webapp audit 結果
- 1.3（LKG snapshot）完成後即可進 Phase 2；Phase 3 須等 Phase 1 全部完成

## Execution-Ready Checklist

- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in `tasks.md`

## Completion / Retrospective Contract

- Review 實作結果對照 `proposal.md` Effective Requirement Description 五項
- 生成 validation checklist：requirement 覆蓋、gap、deferred、evidence
- 不得外洩 raw chain-of-thought；僅輸出可審計結論與證據
- 每 Phase 完成追加 `docs/events/` 條目並勾選 `tasks.md`
