# Spec: specbase_internal-toolcall-dual-track

## Purpose

讓 opencode 以**行程內 native toolcall** 消費 specbase（直呼 `@specbase/lib`），同時對外保留 `@specbase/mcp`（雙管路），從根本消除「把第一方程式碼當外部 MCP 跑」所衍生的工具面 drift 與子行程重複。

## Requirements

### Requirement: opencode 行程內消費 specbase

opencode daemon 必須能在不啟動任何 specbase 子行程的前提下，提供完整的 specbase 工具能力。

#### Scenario: agent 呼叫 event_record（無子行程）

- **Given** opencode daemon 已啟動、specbase 未被列為 opencode 自身的 MCP server
- **When** agent 呼叫 `specbase_event_record({summary, body, scope})`
- **Then** 由行程內 native handler 直呼 `@specbase/lib` 完成 append，回傳 slug；過程不 spawn 任何 `packages/mcp/src/index.ts` 子行程

#### Scenario: 原始碼更新後零 stale

- **Given** `@specbase/lib`（submodule）被 bump 到含新工具的 commit 並重建 daemon
- **When** agent 呼叫該新工具
- **Then** 工具立即可用，無「server 有、工具面沒有」的 drift（因無長駐子行程快照）

### Requirement: 工具面 parity 與規範不破

native 工具集合與簽名必須與現行 MCP 工具面一致，沿用 `specbase_*` id。

#### Scenario: AGENTS.md 引用仍成立

- **Given** AGENTS.md / SYSTEM.md 硬性引用 `event_record` 等為 event log 唯一寫入路徑
- **When** 切換為 native 後
- **Then** 同名工具（`specbase_event_record` 等）仍存在且行為一致，規範引用無需修改

### Requirement: 對外 MCP 不受影響

`@specbase/mcp` 對外 host 的行為必須維持不變。

#### Scenario: Claude Code 仍透過 MCP 用 specbase

- **Given** Claude Code/VSCode 以自身 MCP 設定連 `@specbase/mcp`
- **When** opencode 端改為 native
- **Then** 外部 host 的 specbase 工具面與行為完全不變（雙管路）

### Requirement: 單一真相、結構性防 drift

MCP adapter 與 opencode native 層都只包同一份 lib 工具定義，不得各自實作邏輯。

#### Scenario: lib 改一處、兩路同步

- **Given** `@specbase/lib` 的 `TOOL_DEFINITIONS` 新增/修改一個工具
- **When** 兩 adapter 重建
- **Then** MCP 與 native 兩路同時反映該變更，無需手動同步兩處

## Acceptance Checks

- positive：opencode session 呼叫 `specbase_event_record` 成功 append、`event_search` 撈回；`pgrep -f 'packages/mcp/src/index.ts'` 在 opencode daemon 下**無** specbase 子行程。
- parity：native 工具 id 集合 ⊇ 現行 agent 依賴的 `specbase_*` 集合；簽名一致。
- cross-host：外部 host 的 specbase MCP 工具面與行為不變。
- no-drift：bump submodule 到新工具 commit + 重建後，新工具立即可用，無 stale。
- regression：`event_search`/`event_query`/`wiki_*`/`plan_*`/`spec_*` 行為與 MCP 路徑一致。
- build：`bun build --compile` 出貨 binary 含 `@specbase/lib`（submodule 釘定 commit），可離線於目標機運作。
