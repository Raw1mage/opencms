# Design: specbase_internal-toolcall-dual-track

## Context

opencode 把第一方知識基座 specbase 當外部 local stdio MCP 子行程消費，衍生 stale-child 工具面 drift（`issues/20260611_...stale_local_mcp_child`）與 per-Instance 子行程重複（`issues/20260612_...per_instance_duplication`）。specbase 已分 `@specbase/lib`（核心）+ `@specbase/mcp`（薄轉接層），故 opencode 可改為行程內直接呼叫 lib；對外仍保留 MCP（雙管路）。本案在此前提下設計。

## Goals / Non-Goals

**Goals**
- opencode 不再經 MCP 消費 specbase，改行程內 native toolcall 直呼 `@specbase/lib`。
- 維持工具面 parity（id、簽名不變），AGENTS.md/規範引用零破壞。
- 從結構上根除工具面 drift（單一真相 + 薄 adapter）。
- 對外 `@specbase/mcp` 保留不變。

**Non-Goals**
- full runtime merge（sqlite/索引/生命週期併入 daemon）——後續獨立 plan。
- 改變 specbase 對外 MCP host 的語義。
- 動 docxmcp/drawmiat 等真·外部 MCP。

## Architecture

### Problem framing

opencode 目前把 specbase 當外部 local stdio MCP 子行程消費。把第一方程式碼當外部進程跑，導致 stale-child 工具面 drift 與 per-Instance 子行程重複（兩個 symptom issue）。root fix = opencode 改為**行程內**直接呼叫 `@specbase/lib`；對外的 `@specbase/mcp` 保留給其他 host（雙管路）。

### Target topology

```
                       @specbase/lib  (單一真相：sqlite event log / FTS / wiki / plan 邏輯
                        └── TOOL_DEFINITIONS  ← name + JSON schema + handler(args, ctx)
                              ▲                         ▲
            thin adapter ─────┘                         └───── thin adapter
        @specbase/mcp                               opencode native tool layer
   (stdio MCP server，對外 host：               (ToolRegistry 註冊，行程內呼叫；
    Claude Code / VSCode …，原樣保留)            與 bash/read 同家族；無子行程)
```

兩個 adapter 都**不實作邏輯**，只把同一組 `TOOL_DEFINITIONS` 投影到各自的傳輸層（MCP protocol vs opencode ToolRegistry）。這是 DD-2「單一真相」的結構化落實，也是本案作為 drift root-fix 的核心。

### Components & changes

1. **specbase repo（`/home/pkcs12/projects/specbase`）**
   - `@specbase/lib`：新增匯出 `TOOL_DEFINITIONS`（或等價 registry）——把目前散在 `packages/mcp/src/index.ts` 的 tool name / inputSchema / handler 上提到 lib，handler 只依賴 lib 既有函式。
   - `@specbase/mcp`：重構為薄 adapter，遍歷 `TOOL_DEFINITIONS` 註冊成 MCP 工具（對外行為不變）。

2. **opencode repo（`/home/pkcs12/projects/opencode`）**
   - **submodule**：以 git submodule 引入 specbase（釘 commit），路徑如 `packages/opencode/vendor/specbase/`（或 `external/specbase/`）。把其 `packages/lib` 納入 bun workspace 解析，使 `@specbase/lib` 可 import；`bun build --compile` 出貨 binary 時一併打包。
   - **native tool layer**：新模組（如 `packages/opencode/src/tool/specbase/index.ts`）import `@specbase/lib`，遍歷 `TOOL_DEFINITIONS`，把每個工具註冊進 ToolRegistry，handler 直接呼叫 lib（行程內，無 MCP）。註冊 id 沿用現行 `specbase_*`（見 DD-6）。
   - **移除 specbase 的 MCP 消費**：opencode 自己的 `mcp.json` 不再把 specbase 列為要連的 MCP server（native 工具已取代）。外部 host 的 specbase MCP 設定是另一份、與此無關（DD-7）。

### Data / context flow

- 原 MCP 透過 env 傳 `SPECBASE_TARGET_REPO` / `SPECBASE_PRIMARY_LANG`。native 層改以**呼叫參數**傳 `repo` / lang（lib 函式本就吃 `repo`）。本案維持與現況等價的 target（parity），per-Instance scoping 列為日後可選 refinement，不在本案改語義（DD-8）。
- 工具呼叫路徑：agent → ToolRegistry(`specbase_event_record`) → native handler → `@specbase/lib`.eventRecord(...) → `<repo>/.specbase/events.sqlite`。permission / deferred-catalog 走 opencode 既有機制。

## Decisions

- **DD-1**: 採雙管路（dual-track）。`@specbase/mcp` 對外原樣保留並維護；opencode 對 specbase 的消費改走行程內 native toolcall，不再經 MCP。兩路並存、互不取代。
- **DD-2**: `@specbase/lib` 為單一真相。MCP adapter 與 opencode native 層都只是 lib 的薄包裝，不得各自實作邏輯——根除「兩處實作 → drift」。
- **DD-3**: full runtime merge（specbase 的 sqlite/索引/生命週期完全併入 daemon runtime）排除於本案；留待後續獨立 plan，且本案設計不得阻擋它。
- **DD-4**: opencode 以 **git submodule（釘 commit）** 取得 `@specbase/lib`。可重現 build、出貨 binary 版本確定；更新走手動 bump submodule。排除 path 相依（出貨版本不被釘）與發佈版號（跨 repo 發佈成本過高，本地雙 repo 不需要）。
- **DD-5**: 把 tool 定義（name + JSON schema + handler）上提到 `@specbase/lib` 的 `TOOL_DEFINITIONS`；`@specbase/mcp` 與 opencode native 層皆為其薄 adapter。這是 DD-2 的結構化保證，避免「lib 改了、某個 adapter 沒跟上」的 drift。
- **DD-6**: opencode native 工具沿用現行 MCP 路徑產生的 id（`specbase_event_record` / `specbase_event_search` / …），只換後端（MCP transport → 行程內），不改工具面。→ AGENTS.md / SYSTEM.md 對工具的硬性引用、agent 既有呼叫習慣**零破壞**。
- **DD-7**: 從 opencode **自己的** `~/.config/opencode/mcp.json` 移除 specbase MCP 消費（native 取代）。前置驗證：確認該檔僅 opencode 使用、外部 host（Claude Code/VSCode）的 specbase MCP 來自獨立設定，移除不影響對外雙管路。
- **DD-8**: `repo`/scope 由 native 層以呼叫參數傳入，本案維持與現行 `SPECBASE_TARGET_REPO` 等價（parity）；per-Instance 正確 scoping 列為未來 refinement，不在本案改變 event log 落點語義。
- **DD-9**: DD-9（取代 DD-4）：opencode 取得 @specbase/lib 的機制從 git submodule 改為**發佈成版本化 package + optionalDependencies**。submodule 把 specbase 原始碼焊進 opencode build tree，造成「build 硬綁、runtime 未整合」的併一半狀態（既不可獨立 build、又非 runtime 子系統）。改為：specbase 獨立發佈 @specbase/lib（版號化、lockfile 可重現）；opencode 列為 optionalDependency，native 層改 graceful dynamic import——裝了就點亮 specbase_* 工具，沒裝 opencode 照常 build/跑。達成「specbase 與 opencode 可獨立、可結合，不焊死」。連帶移除 vendor/specbase submodule、tsconfig alias、build.ts 的 submodule-install 步驟；markdown-it/gray-matter 改由 @specbase/lib 套件相依遞移帶入。
- **DD-10**: DD-10（取代 DD-9/DD-5 的交付面）：opencode 對 specbase 的整合改為 **opencode plugin**（剝離性原則）。specbase 為獨立 repo，提供一個 opencode plugin entry（`(input)=>{tool:{...}}`，從 @specbase/lib 的 TOOL_DEFINITIONS 動態建 specbase_* 工具，execute 回字串，repo 經 input.client 讀 config.specbase.repo 保 parity）；opencode 透過 `config.plugin` 的 `file://` 本機路徑載入（自用、免發佈，改版隨 specbase git）。plugin 在 daemon 行程內跑（in-process 速度保留），且為 optional（沒列 config 就沒有 → opencode core 不再認識 specbase）。連帶移除 opencode 端的 vendor/specbase submodule、.gitmodules、tsconfig @specbase/lib alias、packages/opencode/src/tool/specbase、registry.ts 的 SpecbaseTools spread、markdown-it/@types/markdown-it 依賴、build.ts submodule-install 步驟。對外 MCP（@specbase/mcp）保留但本階段不交付（僅自用 plugin mode）。達成：specbase 與 opencode 可獨立可結合、不焊死；in-process 不變；軸二（交付）從「烤進 binary」改為「optional 外掛載入」。

## Risks / Trade-offs

- **跨 repo 耦合**：submodule 釘 commit → 更新 specbase 須手動 bump submodule，否則 opencode 出貨版本停在舊 commit。Trade-off：換取可重現 build（DD-4 已接受）。
- **DD-5 需動 specbase repo**：把 tool 定義上提到 lib 是 specbase 端重構，跨 repo 排序需協調（先 lib 提取、再雙 adapter 接）。若 specbase 端暫不重構，退而求其次：opencode native 層各自包 lib 函式 + 一條 parity 測試，但失去結構性保證（次選，列為 fallback）。
- **`bun build --compile` 打包 submodule lib**：需確認 lib 的所有相依（sqlite 原生綁定等）能被 compile 進 binary；若有原生模組，可能需額外處理。設計階段未證實，列為 planned 階段第一個驗證點。
- **scope 語義**：DD-8 維持 parity，但現行 MCP 的 `SPECBASE_TARGET_REPO` 是固定值；native 化後若日後改 per-Instance，event log 落點會變——本案不改，但要在文件標明以免日後誤判。
- **回退**：native 層出問題時，移除 native 註冊 + 恢復 mcp.json specbase entry 即可退回 MCP 路徑（雙管路使回退低風險）。

## Critical Files

- `packages/opencode/src/mcp/index.ts` — 移除/旁路 specbase 的 MCP 連線消費。
- `packages/opencode/src/tool/specbase/` — 新 native tool 註冊層（本案新增）。
- `packages/opencode/src/session/resolve-tools.ts` / ToolRegistry — native 工具進池路徑（沿用既有，不新增過濾）。
- `packages/opencode/src/session/prompt/enablement.json` + `templates/prompts/enablement.json` — 若 routing 提示需反映 native 來源（兩處同步）。
- `~/.config/opencode/mcp.json` — specbase entry 去留（DD-7）。
- specbase repo：`packages/lib/src/`（新增 TOOL_DEFINITIONS）、`packages/mcp/src/index.ts`（改薄 adapter）。
- opencode submodule 設定：`.gitmodules` + 引入路徑（本案新增）。

## Submodule refs

- 新增：specbase（pinned commit）作為 opencode submodule。`design` 階段尚未實際加入；`tasks` 階段執行 `git submodule add` 並記錄 `pinned_commit`。

## Known-issue links（被本案 root-fix 收編的 symptom）

- `issues/20260611_specbase_event_record_stale_local_mcp_child_issue.md` — stale-child；native 化後 specbase 不再有子行程，此類對 specbase 消失（fix `76cae876c` 仍服務 docxmcp/drawmiat）。
- `issues/20260612_local_mcp_child_per_instance_duplication_issue.md` — per-Instance 重複；native 工具行程內單一，無 per-directory 子行程。

## Open questions（待 design→planned 前收斂）

- TOOL_DEFINITIONS 的具體形狀：handler 簽名 `(args, ctx)` 的 ctx 要帶什麼（repo / lang / abort / logger）才能同時服務 MCP 與 native 兩 adapter？
- `@specbase/mcp` 重構為薄 adapter 是否要與本案同批做，還是 specbase 端先行？（跨 repo 排序）
- enablement.json 是否需要任何改動，或 native 工具沿用 id 後完全透明？
