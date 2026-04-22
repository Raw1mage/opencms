# Handoff: frontend-session-lazyload

## Execution Contract

- 執行起點：`specs/frontend-session-lazyload/` 下 proposal / spec / design / tasks。
- Base branch：`main`（opencode 主線；non-beta 工作面 OK，但 §5 / §6 程式改動涉及 webapp 與 daemon，建議以 `beta-workflow` skill 在 opencode-beta worktree 執行以隔離 XDG）。
- Feature flag：**每個 code path 必須被 `tweaks.cfg` `frontend_session_lazyload` 守護**；flag=0 時行為等價主線。
- 禁止靜默 fallback：meta 呼叫失敗走 `/sessions`（DD-2/DD-9）；cap 設定缺失用 default + warn（DD-3）；其餘錯誤照常拋。
- 禁止 merge 通用型 refactor 到本 plan：本 plan 只處理 lazy-load / part cap / scroll-spy，不含 virtualization、不含 delta 合併策略。

## Required Reads

進 `implementing` 前必讀：

- [proposal.md](proposal.md) — 整體目標、既有機制盤點、G1–G7 決策
- [spec.md](spec.md) — R1–R7 七組 Requirement（GIVEN/WHEN/THEN 等同驗收）
- [design.md](design.md) — DD-1 ~ DD-15 決策依據、R-1 ~ R-10 風險、Critical Files
- [c4.json](c4.json) — 11 個 component 與相依
- [data-schema.json](data-schema.json) — tweaks.cfg keys / meta response shape / telemetry event
- `AGENTS.md` 第一條（禁止靜默 fallback）
- `specs/session-poll-cache/design.md` DD-1 ~ DD-5（理解 SessionCache/ETag 設施，共用）
- `feedback_tweaks_cfg.md`、`feedback_repo_independent_design.md`、`project_codex_cascade_fix_and_delta.md`（auto-memory）

## Stop Gates In Force

執行時遇到以下情況**停止並回報使用者**，不得自行決策：

- **G-1** meta endpoint 設計過程發現需要修改 `Session.messages` 的磁碟計算路徑超出 DD-1 的 cache 擴充範圍 → 停。這代表 server API 契約 drift，需升級為 `extend` mode。
- **G-2** Rebuild heuristic 在 fixture 測試中有 > 10% false positive（真替換被誤判為 append） → 停。代表 DD-5 的 prefix match 長度（1024）不夠，需討論。
- **G-3** tail-window 截斷導致 streaming 中使用者實際體感退化（例如看不到重要段落） → 停。代表 G6 決策需要回頭調整（是否加 toggle）。
- **G-4** Scroll-spy 與 auto-scroll 互動產生無限 loop 或抖動 → 停。代表 DD-6 需要更精細的 mode 鎖。
- **G-5** flag=0 路徑在 regression test 中出現任何行為差異 → 停。代表 §7.1 「byte-by-byte 等價」未達成。
- **G-6** load test 觀察到 flag=1 比 flag=0 記憶體高 → 停。代表 plan 方向錯誤（原本要降記憶體），需重新設計。
- **G-7** 需要改 SSE event schema → 停。超出本 plan scope（見 Non-Goals）。
- **G-8** (R8) `sse_reconnect_replay_sync_required_rate` load test > 10% → 停。代表預設 `max_events=100` 或 `max_age_sec=60` 對典型 reconnect 模式過嚴，需重新校準窗口大小（不能改成「拿掉 bounded」這種回退）。
- **G-9** (R9) 發現現有 codebase 有匯出/備份類消費者依賴 `GET /:id/message` 回「整包所有 messages」→ 停。R-9 預留的 `fullHistory=1` escape hatch 需要 formally 加進 API 契約，不能沉默破壞。
- **G-10** (R9) CMS proxy 整合測試發現 `beforeMessageID` 被某層吃掉 → 停。這是 INV-10 破壞，必須先修 proxy 層才能繼續 R9 後續 task。

## Execution-Ready Checklist

啟動執行前確認：

- [ ] XDG 備份已建立：`~/.config/opencode.bak-YYYYMMDD-HHMM-frontend-session-lazyload/`（opencode AGENTS.md §XDG Config 備份規則）
- [ ] 目前 git 工作樹乾淨（templates/AGENTS.md 若有未 commit 變動先 commit 或 stash）
- [ ] `bun install` 過；daemon 可 `./webctl.sh dev-start` 起來
- [ ] 了解 beta-workflow 是否需介入：§1 / §2 / §3 可純 main 工作；§4–§6 若涉及重啟 daemon / 大 UI 改動建議走 beta
- [ ] 確認 `tweaks.cfg` 當前 `frontend_session_lazyload` 值（預設應該是 `0`）

## Phase Summary Expectations

每個 phase（§1–§7）完成後，依 plan-builder §16.4：

- 更新 tasks.md checkbox（`- [ ]` → `- [x]`）
- 跑 `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/frontend-session-lazyload/`
- 於 `docs/events/event_2026-04-20_frontend-lazyload.md` 追加 phase-summary 段（Done / Key decisions / Validation / Drift / Remaining）
- 無 stop-gate 觸發 → 進下一 phase

## Post-Merge

- Verified 條件：**R1 + R2 + §1–§6** 所有 tasks 完成 + load test 通過 + flag on/off 兩條路徑 regression 皆 green。特別要求：
  - R1 整合測試：ring buffer 塞 1000 events、reconnect、驗證 `writeSSE` 次數 ≤ max_events+1，且 `[SSE-REPLAY]` log 正確
  - R2 整合測試：direct-daemon vs CMS-routed 對同 `beforeMessageID` query 產生 byte-identical daemon log
  - R1+R2 生產觀測：revise 前的 `ses_24b2d916dffeaKQcN79znevt1b` 類情境（gateway 收 7× POST / daemon 收 0×）必須能復現為「gateway 收 N× / daemon 收 N×」
- Promote `verified`：`plan-promote.ts --to verified`，附驗證證據連結。
- Living：合併到 main 後 promote `verified → living`，`specs/architecture.md` 同步更新完成。
- Flag 預設切換與移除屬於後續 `amend` mode（在 living 狀態下進行）。
