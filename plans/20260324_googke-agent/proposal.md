# Proposal

## Why
- 使用者希望 Google Calendar 能以 MCP 方式成為系統擴充能力，而不是一次性硬編進核心功能。
- 此類 app 擴充需求會持續增加，若每次都手工接入，會讓 runtime、設定與 UI 維護成本失控。
- 因此需要把「可安裝能力」提升成正式架構：app market + 內建 MCP registry。

## Original Requirement Wording (Baseline)
- "googke行事曆agent。在本系統擴充api，透過llm解讀使用者語意而管理google行事曆。先survey github是否有人做，直接拿來改。"

## Requirement Revision History
- 2026-03-24 survey 階段：確認最佳外部基底為 `nspady/google-calendar-mcp`，不建議 A2A/獨立 agent server 作為第一版主路徑。
- 2026-03-24 planning 階段：使用者明確指定從技術面應以 MCP 方式實現，並進一步要求將架構提升為 app market，支援隨選安裝擴充能力。

## Effective Requirement Description
1. opencode 要提供內建 app market / MCP registry，讓擴充能力可被 catalog、安裝、設定、啟用與停用。
2. Google Calendar 要作為第一個 market app，提供 LLM 語意驅動的 calendar management 能力。
3. 第一版以本機內建安裝型 app 為主，而不是只註冊外部 MCP server。

## Scope
### IN
- app market 核心資料模型與生命週期。
- 內建 MCP app 的 registry、install state、runtime ownership、settings surface。
- Google Calendar app 的 domain contract、OAuth ownership、tool schema、UI entrypoints。

### OUT
- 遠端 marketplace distribution backend（含外部 MCP market 串接）。
- 第三方 app sandbox hardening 全量方案。
- 非 Google Calendar 的第二批 app 實作。
- Google Calendar OAuth connect flow UI。

## Non-Goals
- 不把所有現有 tool 全部重新包成 market app。
- 不在第一版加入自動 fallback 到外部 server 或雲端服務。
- 不實作 app store 商業化功能（付款、評價、排名）。

## Constraints
- 必須遵守 fail-fast，不新增 silent fallback mechanism。
- Google Calendar app 必須對齊既有 `account/auth` 單一真相來源，不能自建第二份帳號系統。
- Web/TUI 應共享同一套 app 安裝狀態與設定真相來源。

## What Changes
- 新增 app market / MCP registry 架構層。
- 新增 app install lifecycle 與 app metadata/catalog surface。
- 定義 Google Calendar app 的原生整合契約，而不是外掛式 demo server。
- 將未來擴充能力從「一次一個 feature 特案」轉成「app 型能力」演進路線。

## Capabilities
### New Capabilities
- App Catalog：列出可安裝 app、版本、狀態、權限需求與設定摘要。
- Managed MCP App Lifecycle：安裝、啟用、停用、移除、健康狀態觀測。
- Google Calendar App：透過 LLM 解讀語意並操作 calendar event / freebusy / search。

### Modified Capabilities
- 現有 runtime/tool 管理：從靜態內建能力，擴展為可被 registry 掛載與治理的 app capability surface。
- 現有 account/auth：需支援 app-scoped OAuth ownership 與 token lifecycle，但仍維持統一身份服務。

## Impact
- 影響 backend runtime、tool registry、auth/account、web/tui settings/admin surface、docs/architecture。
- 後續所有「接第三方能力」需求，都可沿同一 app market 架構演進。
