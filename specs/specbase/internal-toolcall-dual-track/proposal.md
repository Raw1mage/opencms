# Proposal: specbase_internal-toolcall-dual-track

## Why

- specbase 是第一方知識基座（event log / wiki / plan 的 sqlite + FTS 核心），卻被 opencode 當成**外部 local stdio MCP 子行程**來跑（`mcp.json`: `bun packages/mcp/src/index.ts`）。把第一方程式碼當外部 MCP 跑，衍生了一整類本不該存在的生命週期問題：
  1. **stale local-MCP child**：子行程啟動於 server 原始碼更新之前 → 服務舊 tool 清單，工具面靜默 drift。confirmed/opencms live 複現（`issues/20260611_specbase_event_record_stale_local_mcp_child_issue.md`）。已落一個治標重連 fix（commit `76cae876c`），對真·外部 MCP 仍有用，但對 specbase 是多餘的繞路。
  2. **per-Instance 子行程重複**：MCP state 以 `Instance.directory` 為 key + specbase 靜態 enabled → daemon 每服務一個 project 目錄就各 spawn 一份 specbase（`issues/20260612_local_mcp_child_per_instance_duplication_issue.md`）。
- 這兩個都是 symptom；root 是「specbase 對 opencode 而言不該是外部進程」。把 opencode 對 specbase 的消費改成**行程內 native toolcall**，整類問題從根消失：無子行程、無啟動時序、無 listTools 快照、無 per-directory 重複；原始碼一改、daemon 一重建即生效（與任何內建工具一致）。

## Original Requirement Wording (Baseline)

- "我早就說了specbase應該要併到daemon裏成為runtime的。就算不併，它也不應該是mcp，而是直接走internal toolcall"
- 範圍拍板："mcp對外保留。內部走toolcall路線。雙管路"

## Requirement Revision History

- 2026-06-11: initial draft created via plan-init.ts
- 2026-06-11: 範圍定為 internal-toolcall + 對外保留 MCP（雙管路）；full runtime merge 明確排除於本案。

## Effective Requirement Description

1. opencode daemon **不再透過 MCP** 消費 specbase；改為直接相依 `@specbase/lib`，在行程內呼叫其核心函式。
2. specbase 現有對 opencode 暴露的工具面（`event_record` / `event_search` / `event_query` / `wiki_*` / `plan_*` / `spec_*` 全套）改以 opencode **native 工具**註冊（與 bash/read 同家族、走同一個 ToolRegistry / permission / deferred-catalog 機制）。
3. `@specbase/mcp` 轉接層**原樣保留並繼續維護**，給 Claude Code / VSCode 等外部 host 透過 MCP 使用（雙管路）。
4. 兩條路（internal native + external MCP）皆**只包同一份 `@specbase/lib`**，確保行為單一真相、不再 drift。

## Scope

### IN
- opencode 端：新增 `@specbase/lib` 相依、一個 specbase native-tool 註冊層（把 lib 操作映射成 opencode 工具）、從 opencode 的 specbase 消費路徑移除 MCP（mcp.json 對 specbase 的 entry 之去留）。
- 工具 parity：內建工具與現有 MCP 工具面在工具集合與簽名上的對齊策略。
- scope/context 注入：原 MCP env（`SPECBASE_TARGET_REPO` 等）在 internal 路徑的等價傳入。
- 收編兩個 symptom issue（標註被本案 root-fix 取代的部分）。

### OUT
- **Full runtime merge**：把 specbase 的 sqlite/索引/生命週期完全併入 daemon runtime（非本案；本案只做行程內 toolcall）。
- 砍掉或改寫 `@specbase/mcp`（對外保留，不動其對外行為）。
- 其他真·外部 MCP（docxmcp / drawmiat）的去留（不動；stale-child fix 繼續服務它們）。

## Non-Goals

- 不追求 specbase 與 opencode 合併成單一 repo。
- 不改變 specbase 對外（MCP host）可見的工具語義。

## Constraints

- 兩個獨立 repo：opencode（`/home/pkcs12/projects/opencode`）與 specbase（`/home/pkcs12/projects/specbase`）。opencode 取得 `@specbase/lib` 的方式（workspace link / 發佈 package / vendor）是設計階段必須收斂的關鍵決策。
- AGENTS.md / SYSTEM.md 多處硬性引用 `event_record` 等工具名為 event log 唯一寫入路徑；internal 工具命名須維持規範引用不破。
- 不得自行 restart daemon（僅 `system-manager:restart_self` / 使用者）；部署驗證須走合法路徑。
- Enablement Registry 雙檔同步規範（`enablement.json` runtime + template 兩處）。

## What Changes

- opencode 多一個「specbase native tools」模組；少一條「連 specbase MCP 子行程」的路徑。
- specbase 的工具邏輯成為 opencode 可直接呼叫的行程內能力。

## Capabilities

### New Capabilities
- specbase native toolcall：opencode 行程內直接呼叫 `@specbase/lib`，無 MCP transport。

### Modified Capabilities
- specbase 工具暴露：對 opencode 從「外部 MCP 子行程動態 listTools」改為「行程內靜態註冊」；對外 host 維持 MCP 不變。

## Impact

- 影響碼：`packages/opencode/src/mcp/index.ts`（specbase 消費路徑）、工具註冊層（ToolRegistry / resolve-tools）、`enablement.json`（兩處）、`~/.config/opencode/mcp.json`（specbase entry）。
- 規範：AGENTS.md / SYSTEM.md 對 specbase 工具的引用一致性。
- 收編 issues：`20260611_..._stale_local_mcp_child`、`20260612_..._per_instance_duplication`（specbase 部分被 root-fix 取代）。
- 外部 host：無感（MCP 對外保留）。
