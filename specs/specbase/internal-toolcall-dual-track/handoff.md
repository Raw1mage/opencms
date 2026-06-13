# Handoff: specbase_internal-toolcall-dual-track

## Execution Contract

- 目標：opencode 改以行程內 native toolcall 消費 specbase（直呼 `@specbase/lib`），對外保留 `@specbase/mcp`（雙管路）。範圍見 proposal/spec；決策見 design.md DD-1..DD-8。
- 不在範圍：full runtime merge（DD-3）；改 specbase 對外 MCP 語義；動 docxmcp/drawmiat。
- 跨 repo：本案同時觸及 specbase repo（DD-5 提取 + mcp 薄 adapter）與 opencode repo（submodule + native 層）。specbase 端先行（T1/T2），opencode 端再接（T3+）。
- 不得自行 restart daemon：部署僅走 `system-manager:restart_self` 或使用者（T11 為 user-gated stop gate）。
- 進實作前備份 XDG config 白名單（已於本 plan 工作期備份：`~/.config/opencode.bak-20260611-2342-mcp-stale-local-reload`；若跨日再次實作需重備）。

## Required Reads

- 本包：proposal.md / spec.md / design.md（DD 全表）/ idef0.json / grafcet.json / sequence.json / data-schema.json。
- symptom issues：`issues/20260611_specbase_event_record_stale_local_mcp_child_issue.md`、`issues/20260612_local_mcp_child_per_instance_duplication_issue.md`。
- opencode 工具註冊路徑：`packages/opencode/src/mcp/index.ts`（`tools()` / `toolID()` / `create()`）、`packages/opencode/src/session/resolve-tools.ts`、`packages/opencode/src/tool/tool-loader.ts`。
- specbase：`packages/lib/src/index.ts`（exports）、`packages/mcp/src/index.ts`（現有 tool 註冊，待提取）。
- event 回溯：本 slug 的 event log（立案/設計/build 探針）。

## Stop Gates In Force

- **G1**：T6 移除 opencode mcp.json specbase entry 前，必須先證實外部 host 的 specbase MCP 來自獨立設定（否則會誤砍外部雙管路）。
- **G2**：T11 build+部署為 user-gated——不得自行 restart daemon；rebuild 失敗讀 restart_self 回傳的 errorLogPath 修正後重試，不繞過。
- **G3**：T2 重構 `@specbase/mcp` 後，對外 listTools 必須與重構前逐項一致（外部 host 零感知）才可繼續。
- **G4**：DD-5 若 specbase 端暫不提取 TOOL_DEFINITIONS，採 fallback（native 層各自包 lib 函式 + parity 測試 T8），但須在 design.md 標明失去結構性保證。

## Execution-Ready Checklist

- [x] build 可行性已證（T0）。
- [ ] specbase commit 選定為 submodule pin 點（T3）。
- [ ] 確認 opencode 提供 gray-matter/markdown-it（T4）。
- [ ] G1 外部 host MCP 設定獨立性已查（T6 前置）。
- [ ] 部署窗口與使用者約定（T11）。
