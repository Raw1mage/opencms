# Implementation Spec

## Goal

- 建立一套內建 MCP app market 架構，讓 opencode 可隨選安裝/啟用擴充能力，並以 Google Calendar 作為第一個可由 LLM 語意驅動的 market app。

## Scope

### IN

- 定義內建 MCP registry / app market 的資料模型、安裝生命週期、執行契約、權限與設定面。
- 定義 Google Calendar app 作為第一個 market app 的整合邊界。
- 明確規劃如何重用 `nspady/google-calendar-mcp` 類型實作，但將其改造成 opencode 原生管理的 app，而非外部獨立 server。
- 規劃 Web/TUI 中的 app 安裝、設定、啟用/停用、狀態觀測入口。

### OUT

- ~~本 plan 不直接實作完整 app market。~~ → **已實作 app market registry + UI**
- ~~本 plan 不直接完成 Google Calendar OAuth / CRUD 產品代碼。~~ → **已實作 Google Calendar REST client + 7 tool executors**
- 本 plan 不處理第三方付費、計費、上架審核、遠端下載 marketplace backend。

## Assumptions

- opencode 現有 runtime 可承載內建管理的 MCP app process / module lifecycle。
- 第一版 app market 以本機/同 repo 內建 catalog 為主，不依賴遠端商店服務。
- Google Calendar write 能力仍以使用者 OAuth 授權為主，不能用 API key 取代。

## Stop Gates

- 若現有 tool/runtime 架構無法安全承載「可安裝 app + MCP lifecycle」，需停下來先做 runtime capability re-plan。
- 若 app market 需要引入遠端下載、簽章驗證或 sandboxing 才能成立，需先做安全決策再進 implementation。
- 若 Google account/auth 邊界無法與既有 `packages/opencode/src/auth` 對齊，需停下來重畫身份模型。

## Critical Files

- `packages/opencode/src/auth/index.ts`
- `packages/opencode/src/account/index.ts`
- `packages/opencode/src/provider/`
- `packages/opencode/src/tool/`
- `packages/opencode/src/server/`
- `packages/app/src/components/`
- `packages/app/src/context/`
- `specs/architecture.md`
- `docs/events/event_20260324_google-calendar-agent-survey.md`

## Structured Execution Phases

- Phase 1: 建立 app market / MCP registry domain model、安裝狀態機、catalog 與 runtime ownership 邊界。 ✅
- Phase 2: 建立 Google Calendar app integration contract，定義 auth、tool surface、config、observability 與 UI entrypoints。 ✅
- Phase 3: 實作最小可用 market shell 與第一個 app 的 install/enable/configure flow。 ✅
- Phase 4: 補齊 validation、docs sync、architecture sync 與後續多 app 擴充策略。 ✅ (architecture sync pending)

## Validation

- 規劃驗證：artifacts 需明確描述 app market lifecycle、Google Calendar app flow、failure boundaries、無 silent fallback 原則。
- 實作後驗證應至少包含：app catalog 可見、install/uninstall/enable/disable flow、Google Calendar OAuth connect、calendar read/write tool-calling smoke test。
- 文件驗證：`proposal.md` / `spec.md` / `design.md` / `tasks.md` / `handoff.md` / diagrams 必須互相一致，且能直接 hand off 給 build agent。

### Documentation Sync Completion Gate

- Implementation 不得在以下文件同步完成前宣稱 done：`docs/events/event_20260324_google-calendar-agent-survey.md` 與 `specs/architecture.md`。
- `docs/events` 必須補記本 feature 的最終落地決策與 build evidence：managed app registry 邊界、install lifecycle、auth/config/runtime state 定義、Web/TUI operator surfaces、fail-fast error observability、以及 beta worktree 執行/驗證註記（若 build 於 beta worktree 進行）。
- `specs/architecture.md` 必須同步本 feature 造成的長期架構變更：managed app registry authority、catalog/runtime ownership、Google Calendar managed app integration boundary、canonical auth/account 對 app OAuth 的 ownership、以及 app lifecycle state machine 與 operator-visible state contract。
- Completion gate 為：build handoff 或 implementation 驗收時，必須逐項確認上述兩類文件已更新且內容與實作/驗證結果一致；未完成 doc sync verification 視為 task 未完成。

### Validation Command Contract

- **Repo guard**：`bun x tsc --noEmit` ✅ (0 new errors)
- **Registry tests**：`bun test --preload ./packages/opencode/test/preload.ts packages/opencode/test/mcp/app-registry.test.ts` ✅ (13 pass)
- **App structure tests**：`bun test --preload ./packages/opencode/test/preload.ts packages/opencode/test/mcp/google-calendar-app.test.ts` ✅ (4 pass)
- **Smoke test**：`bun run smoke:google-calendar-managed-app` — 尚需真實 Google OAuth token，暫未執行

### Operator-Visible Acceptance Checks

- **Install**：operator 在 Web/TUI app catalog 可看到 `google-calendar` 從 `available` 轉為 `installed`，且 UI 不要求手動填寫外部 MCP server wiring。
- **Configure**：operator 開啟 app detail 時，明確看到 required scopes、required config、目前 config completeness；若缺欄位，狀態停在 `installed` 或 `error`，不可假裝 `ready`。
- **Auth-required**：在 app 已 enable 但未完成 OAuth 時，operator 發動 calendar action 或 smoke flow，系統必須回傳 `authorization_required`（或同義明確狀態），並顯示唯一正確下一步為 connect/auth，而不是 fallback 到其他 account/provider。
- **Enable/Disable**：operator 啟用 app 後可看到狀態轉為 `enabled`；停用後轉為 `disabled`，且 runtime/tool surface 立即不再暴露 calendar capability。
- **Runtime-ready**：operator 完成 install + config + auth 後，可看到 app 進入 `ready`，並能以 smoke flow 驗證至少一個 read path 與一個 write path 由 managed app tool contract 成功處理。
- **Fail-fast error states**：對於未安裝、未授權、config 缺失、runtime 初始化失敗，各自都必須呈現獨立可觀測 error state 與 remediation 線索；不得自動改用其他 app/account，也不得 silent fallback。

## Handoff

- Build agent must read this spec first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md / handoff.md before coding.
- Build agent must materialize runtime todo from tasks.md and preserve planner task naming.
- Build agent must prefer delegation-first execution when the task slice can be safely handed off.
