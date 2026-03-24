# Design

## Context

- opencode 已有 provider/account/model 控制平面，但尚未有「可安裝 app」這一層正式抽象。
- 現有 MCP 能力多半被視為外部工具接入，而不是由本系統內建治理的 installable capability。
- Google Calendar 是典型高需求外部能力：有 OAuth、長生命週期設定、可觀測錯誤面、可被 LLM 工具調用，適合作為第一個 app market 驗證案例。

## Goals / Non-Goals

**Goals:**

- 讓 app 成為 runtime 內的一級實體，而不是零散外掛設定。
- 定義內建 MCP registry，使未來 app 可沿同一生命週期安裝與治理。
- 讓 Google Calendar app 的 auth / config / tools / UI 面都對齊現有 control plane。

**Non-Goals:**

- 不在本次設計內完成完整安全 sandbox。
- 不要求所有未來 app 一定使用同一技術棧實作，但第一版以內建/受控 MCP app 為主。

## Decisions

- 採用 **內建 MCP registry / app market**，不是單純「外部 MCP 連線列表」。理由是使用者要的是 productized capability installation，而非 operator-only wiring。
- Google Calendar 採 **managed app** 路徑：重用外部 repo 的 domain/service/tool 設計，但 runtime ownership 留在 opencode 本體。
- App lifecycle 必須有明確狀態：`available -> installed -> configured -> enabled -> ready / error / disabled`，避免隱式可用性。
- OAuth/token/account 一律掛在既有 `auth/account` authority 之下；app 僅宣告所需 scopes 與 config contract。

## Data / State / Control Flow

- App catalog 定義 app metadata、版本、安裝來源、所需設定、所需權限與能力清單。
- Operator 由 Web/TUI 觸發 install/enable/configure 行為，backend app registry 寫入 install state 並發布 bus/event 給前端同步。
- 當 Google Calendar app 進入 connect flow，app registry 呼叫 canonical auth service 執行 OAuth，並將回傳 identity 綁定到 app capability binding。
- LLM/tool-calling 階段不直接連外部 server，而是經由 opencode runtime 解析 app capability → app tool adapter → Google Calendar service。
- 失敗時保留明確 app state（未安裝 / 未授權 / config 缺失 / runtime error），而不是 fallback 到其他 account 或其他 provider。

## Risks / Trade-offs

- App market 抽象若做太重，會拖慢第一個 app 落地 -> 採 MVP：先做 built-in catalog + managed install lifecycle，不做遠端商店。
- 若直接重用外部 MCP server process，會產生雙份狀態與觀測裂縫 -> 選擇抽 service/tool contract 而非整包外掛 server。
- App-scoped OAuth 會碰到既有 account/auth 模型調整 -> 必須優先設計 app capability binding，而不是讓 app 自帶 token store。

## Validation / Acceptance Design

- MVP 驗證分成兩層：**repo guard** 與 **managed-app acceptance**。
- Repo guard 先以 `bun x tsc --noEmit` 擋住型別回歸；managed-app acceptance 則在 build slice 內新增明確 command contract：`bun run test:managed-app-registry`、`bun run test:app-market-shell`、`bun run test:google-calendar-managed-app`、`bun run smoke:google-calendar-managed-app`。
- Operator 驗收必須直接觀察 registry state 與 UI/TUI state label，而不是依賴隱式 tool success 推斷：
  - install 後看得到 `available -> installed`
  - config 未完成時不可進入 `ready`
  - auth 未完成時必須顯示 authorization-required，而非嘗試其他 account/provider
  - disable 後 calendar capability 必須從 runtime surface 移除
  - ready 僅在 install/config/auth/runtime health 都成立時可見
  - runtime error 必須保留 app-specific remediation evidence

## Documentation Sync Requirements

- `docs/events` 屬於本 feature 的執行紀錄面：build 完成前必須記錄 managed app registry 邊界、install/uninstall/enable/disable 實際 lifecycle、auth/config/runtime 各 state 與錯誤態、Web/TUI operator surface 實際入口、fail-fast observability evidence，若採 beta worktree 執行也必須記錄 worktree-specific build/validation note。
- `specs/architecture.md` 屬於長期 SSOT：只有當 managed app registry authority、catalog 與 runtime ownership、Google Calendar app 與 canonical auth/account 邊界、operator surface contract、以及 fail-fast state/observability model 已同步入 architecture，才算完成 architecture sync。
- 任何 build handoff / acceptance review 都必須把「doc sync verified」當成 completion gate；若僅有程式碼與測試、但未同步上述 docs，則本 MVP 不可標記完成。

## Critical Files

- `packages/opencode/src/auth/index.ts`
- `packages/opencode/src/account/index.ts`
- `packages/opencode/src/mcp/app-registry.ts` — Managed App Registry authority (catalog, lifecycle, persistence, bus events)
- `packages/opencode/src/mcp/index.ts` — MCP tool surface integration (managed app tool routing)
- `packages/opencode/src/mcp/apps/google-calendar/client.ts` — Google Calendar REST API client
- `packages/opencode/src/mcp/apps/google-calendar/index.ts` — Google Calendar tool executors + canonical auth resolution
- `packages/opencode/src/server/routes/mcp.ts` — Managed app REST API endpoints
- `packages/app/src/components/dialog-app-market.tsx` — App market dialog (Synology-style card grid)
- `packages/app/src/pages/layout/sidebar-shell.tsx` — Sidebar shell (app-market icon entry)
- `packages/app/src/pages/layout.tsx` — Layout wiring (dialog mount)
- `packages/ui/src/components/icon.tsx` — app-market icon definition
- `specs/architecture.md`
