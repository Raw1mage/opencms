# Handoff: codex-fingerprint-alignment

## Execution Contract

- **Scope**：依 `tasks.md` Phase 1 → 3 → beta soak → fetch-back → 2 → 4 的順序執行。每個 phase 完成後在 `docs/events/` 留 slice summary。
- **Beta isolation**：所有程式碼改動都先落在 beta worktree（`beta/codex-fingerprint-alignment`）；main repo 只在 fetch-back 時接收變更。
- **XDG backup**：第一個 phase 開始前必須有 `~/.config/opencode.bak-<timestamp>-codex-fingerprint` 快照，否則視為違規。
- **Daemon lifecycle**：任何重啟透過 `system-manager:restart_self` MCP tool；禁止 `bun ... serve` / `opencode serve` / 手 `kill` daemon。
- **Submodule 同步順序**：Phase 3 只 checkout tag，不 merge、不 rebase upstream。submodule pointer 更新 commit 在 main repo。
- **Classification**：程式碼動作落 `feat(codex-provider): ...` / `chore(codex-provider): bump CODEX_CLI_VERSION` / `test(codex-provider): ...` 等 conventional commit；slice summary 走 `docs(events): ...`。
- **No silent fallback**：若 Phase 3 盤點發現 upstream 新增必要（非 conditional）header，不可忽略；stop 並回報使用者考慮 `revise` mode。

## Required Reads

- `specs/codex-fingerprint-alignment/proposal.md` — why / scope / 4 phase 優先序
- `specs/codex-fingerprint-alignment/spec.md` — GIVEN/WHEN/THEN Requirement 與 Acceptance Checks
- `specs/codex-fingerprint-alignment/design.md` — DD-1..DD-8 決策、R1..R5 風險、關鍵檔案
- `specs/codex-fingerprint-alignment/data-schema.json` — header 欄位契約
- `specs/codex-fingerprint-alignment/sequence.json` — P1..P5 流程
- `specs/codex-fingerprint-alignment/grafcet.json` — S0..S10 狀態機與失敗回流
- `AGENTS.md`（project 根）— XDG 備份、Daemon 生命週期規則
- `docs/events/event_20260424_codex_session_cpu_burn.md` — 下游 spec 的協調背景

## Stop Gates In Force

阻擋繼續推進、必須停下來回報使用者的條件：

1. **Beta 驗收失敗**（tasks §3.5）：連續兩次後台觀察 ≥ 1% 第三方判定比例 → stop，回 Phase 3 盤點；可能需 `revise` mode 擴大範圍（例如檢查 TLS 層）。
2. **Upstream 破壞性改動**（tasks §2.3）：`rust-v0.122.0..rust-v0.125.0-alpha.1` diff 顯示新增必要 header / body 欄位 → stop，回報使用者決定是否併入本 spec 或升級為 `revise`。
3. **Unit test 回歸**：任何既有 test 失敗且非本次變更預期 → stop，先修回歸再繼續。
4. **XDG 備份缺失**：發現無 `opencode.bak-*` 快照就嘗試動 daemon / 跑 test → stop，先補備份。
5. **Daemon lifecycle 違規**：發現 AI / script 試圖直接 `kill` 或 spawn daemon（`opencode serve`、`bun ... serve`、直接 `systemctl`）→ stop；使用 `restart_self` MCP tool 重做。
6. **Fetch-back 前 regression**：beta regression check 發現既有 WS/HTTP 成功路徑下降 → stop；不可 fetch-back。
7. **使用者中斷**：任何時點使用者說「停」/「stop」/「pause」→ 完成當前 item 後退出 autorun；不推進下一個 item。
8. **Submodule 同步衝突**：若 `refs/codex` 已被人改過（dirty、未 commit 的 local 修改）→ stop，先釐清狀態。

## Execution-Ready Checklist

實作開始前要勾完（視同 Phase 0）：

- [ ] 確認目前 `.state.json.state` = `planned` 或 `implementing`
- [ ] `~/.config/opencode.bak-<timestamp>-codex-fingerprint/accounts.json` 存在（白名單快照；依 AGENTS.md XDG 新規則）
- [ ] beta worktree `opencode-beta/` 可用，branch `beta/codex-fingerprint-alignment` 已建立或可建立
- [ ] `refs/codex` submodule 目前狀態乾淨（無 local 改動）：`git -C refs/codex status --porcelain` 為空
- [ ] `bun install` 已跑，`bun test packages/opencode-codex-provider` 當前 baseline 全綠
- [ ] `system-manager:restart_self` MCP tool 可用（beta daemon 連得上 gateway）
- [ ] OpenAI 官網後台人工查看權限就位（執行 §3.2、§3.4 時需要）
- [ ] 使用者已同意進入 implementing（或主動說 autorun / build_mode）
