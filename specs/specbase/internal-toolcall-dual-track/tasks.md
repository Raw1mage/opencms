# Tasks: specbase_internal-toolcall-dual-track

全部完成並部署上線（2026-06-12）。執行走 beta-workflow（specbase repo + opencode repo 各自 beta→test→main）。

## 0. De-risk

- [x] T0 build-feasibility 探針：`bun build --compile` 打包 `@specbase/lib`（含 sqlite）。通過——specbase 用 `bun:sqlite`（內建，無 native addon）。

## 1. specbase 端（DD-5）

- [x] T1 `@specbase/lib` 新增 `TOOL_DEFINITIONS`（22 工具 name/schema/handler，handler `(args, ctx{repo,lang})` 回 ToolResult）。
- [x] T2 `@specbase/mcp` 重構為薄 adapter；對外 listTools/結果逐位元相同。commit specbase `6439b62`，push github:Raw1mage/specbase（新建 private），finalize specbase main。

## 2. opencode 端

- [x] T3 git submodule `vendor/specbase` 釘 `6439b62`（specbase 無 remote → 新建 GitHub repo 當 URL）。
- [x] T4 `@specbase/lib` 解析：改 tsconfig paths alias（specbase 自身是 workspace root，不能當巢狀 member）；markdown-it + @types/markdown-it 加進 opencode；submodule 以 `bun install --production` 自帶 runtime deps（避免 @types/bun 污染 typecheck）。
- [x] T5 native tool 層 `packages/opencode/src/tool/specbase/index.ts`：JSON-Schema→zod、行程內 dispatch、id `specbase_*`（DD-6），spread 進 ToolRegistry.all()。
- [x] T6 移除 opencode 自身 `~/.config/opencode/mcp.json` 的 specbase（mcp:{}）；G1 先確認外部 host MCP 在獨立 `~/.claude.json`。新增 `opencode.json` `specbase.repo`（DD-8 parity，取代 MCP env）。
- [x] T7 enablement.json prefer hint（`mcp__specbase__*` → `specbase_*`）：兩處（runtime + template）已改，commit `a0657a24d`。**待下次 restart 生效**（cosmetic、非阻塞）。

## 3. 驗證

- [x] T8/T9 parity + 行程內 roundtrip：native probe 22 個 `specbase_*`、zod 參數、event_record→event_search roundtrip pass；specbase 端 smoke 同樣 pass。
- [x] T10 `tsgo -p packages/opencode` 0 error；full binary build 0（webctl build-binary）。

## 4. 部署與收尾

- [x] T11 部署：`webctl.sh restart`（我無 restart_self；webctl 為 CLAUDE.md 認可路徑）→ binary atomic replace，daemon systemctl 重啟。
- [x] T12 驗收（infra）：新 daemon 95537 健康；**opencode daemon 下 0 個 specbase MCP 子行程**；外部 host 雙管路保留。（建議使用者再做一次 session 內 specbase_event_record runtime sanity check。）
- [x] T13 收編 symptom issue：stale-child（20260611）、per-instance-dup（20260612）specbase 部分由本案取代 → 移 observing。
- [x] T14 plan 推進 verified。

## Follow-up

- [x] build pipeline 納入 `cd vendor/specbase && bun install --production`（script/build.ts，commit `a0657a24d`，build-binary 驗證通過）。
- [x] T7 enablement hint 更新（commit `a0657a24d`）。
- full runtime merge（DD-3，後續獨立 plan）。
