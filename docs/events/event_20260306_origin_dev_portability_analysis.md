# Event: origin/dev portability analysis

Date: 2026-03-06
Status: In Progress

## 需求

- 分析 `origin/dev` 最新增量是否可移植到 `cms`
- 嚴禁直接 merge upstream；僅允許分析與可移植性評估
- 使用 `refacting-merger` 對 `origin/dev` 與 `HEAD` 進行差異分析

## 範圍

### IN

- `git fetch origin dev`
- 分析 `HEAD..origin/dev` 的 upstream delta
- 依 cms 保護區（multi-account / rotation3d / admin / provider split）評估移植風險

### OUT

- 不直接 merge / cherry-pick / port code
- 不修改 runtime 行為
- 不在本次任務執行實作驗證

## 任務清單

- [x] 讀取 `docs/ARCHITECTURE.md`
- [x] 確認 target ref = `HEAD`
- [x] `fetch origin dev`
- [x] 執行 `refacting-merger` 差異分析
- [x] 彙整可移植 / 高風險 / 建議跳過項目
- [x] 補齊 Validation 與 Architecture Sync 記錄

## Debug Checkpoints

### Baseline

- Current branch: `cms`
- Working tree: clean (`git status --short --branch` 僅顯示 `## cms...raw1mage/cms`)
- Upstream fetch result: `origin/dev` updated from `502dbb65f` to `d4d1292a0`
- 目標：評估 `origin/dev` 最新增量對 `cms` 的可移植性

### Execution

- User strategy confirmed: 不逐一決策；改採「先把高價值低風險功能全部做好，再試用後回退不滿意項目」。
- 已啟用 `refacting-merger` MCP，並以 `sourceRef=origin/dev`、`targetRef=HEAD` 執行 delta 分析。
- 未帶 ledger 時，工具顯示 `totalFromSource=837`；套用 `/home/pkcs12/projects/opencode/docs/events/refactor_processed_commits_20260225.md` 後，`processedCount=593`，剩餘待評估 upstream commits 約 `244`。
- 依可見分析切片（138 筆）統計，風險分布約為：`low=112`、`medium=12`、`high=14`；預設決策約為：`ported=98`、`skipped=40`。
- 低風險可移植群組：session/review UI 細修、permission auto-respond UX、message/diff 顯示修正、desktop/release tooling、i18n/docs sync、storybook/infra 整理。
- 中高風險群組：workspace/control-plane 基礎設施、provider/runtime error path、MCP child process lifecycle、TUI session navigation / task tool 呈現。
- 已建立批次計畫：`/home/pkcs12/projects/opencode/docs/events/refactor_plan_20260306_origin_dev_low_risk_high_value_round1.md`
- Batch A（partial）已開始，先移植可直接對應到 cms 現況的 low-risk UI polish：
  - `931286756` / `c95febb1d`：session tabs compact styling、tooltip gutter、drag preview、inactive file icon muted style
  - `09e1b98bc`：file tree 開啟但切到 `all` tab 時，session 主區仍維持 centered 版型
  - `270d084cb`：assistant text 不再整段刪除 workspace path；僅對 path-like metadata 做相對化
  - `session-side-panel` 對應同步：close tooltip gutter、add-file 按鈕圓角
- Batch B（partial）已落地：permission auto-respond / indicator UX
  - `e9a7c7114`：permission auto-respond 改為沿 session lineage 生效；child session 的 permission 也會正確套用 auto-accept 設定
  - `b0b88f679`：project/session sidebar indicator 會忽略已 auto-respond 的 permission，並以 warning badge 呈現仍需人工處理的 permission
  - `session-request-tree` 已補 include predicate，供 permission/question 樹狀檢查時過濾 auto-respond 項目
- Batch C（partial）已落地：desktop / release tooling
  - `0da8af8a2`：desktop `openPath` 邏輯移入 Rust command，前端改為直接呼叫 `commands.openPath(...)`
  - `967313234` / `a692e6fdd` / `b1bfecb71`：新增 `packages/desktop/scripts/finalize-latest-json.ts`，補齊 latest.json finalizer 與正確的 GitHub release download URL（`v${version}`）
- Batch A（continued）補入：
  - `1f2348c1e`：bash tool output 可被選取/複製，避免 shell output 文字無法選取
  - `438610aa6`（partial）：新增 `SessionRetry` 錯誤卡片與 retry 文案，讓 usage-limit / quota retry 狀態顯示更清楚；本輪先移植 UI 呈現層與 locale keys，未動更深的 retry orchestration
  - `2a2082233`：skill tool call 現在會直接顯示 skill 名稱，而不是只顯示 generic tool 標題
- 對 cms 特別值得深挖但不可直接搬運的 upstream 變更：
  - `c12ce2ffff38fae11e22762292c56f1e71c387e7` `feat(core): basic implementation of remote workspace support (#15120)`
  - `cec16dfe953a67cce9c0b6e597d323fb78600c57` `feat(core): add WorkspaceContext (#15409)`
  - `3ee1653f40360fc0a221251f7241425cc7c58d28` `feat(core): add workspace_id to session table (#15410)`
  - `c4c0b23bff52878014007e53de7657a59df95915` `fix: kill orphaned MCP child processes ... (#15516)`
  - `3dc10a1c165e0a8c567718c33ddd8a62814e0c14` `Change keybindings to navigate between child sessions (#14814)`
- Batch B（continued）已完成 `b7605add5` 方向的 directory-level auto-accept 補齊：
  - `packages/app/src/context/permission-auto-respond.ts` 已支援 directory accept key 與 session/directory 混合查詢。
  - `packages/app/src/context/permission.tsx` 補上 directory-level enable/disable/toggle、session disable 覆寫為 `false`、以及 `permission: "allow"` 的目錄級 bootstrap。
  - `packages/app/src/components/prompt-input.tsx` 移除 local `pendingAutoAccept`，新 session composer 直接反映目前 directory auto-accept 狀態。
  - `packages/app/src/pages/session/use-session-commands.tsx` 的 `mod+shift+a` 現在即使尚未建立 session 也能切換 auto-accept。
- Batch A（continued）補入 `39691e517`：
  - `packages/app/src/pages/layout.tsx` 已移除 sidebar 中 new session / new workspace 按鈕的鍵盤捷徑 tooltip，避免在主要 CTA 上重複顯示 hover 文案。
- Batch A（continued）補入 `356b5d460`：
  - `packages/app/src/pages/layout.tsx` 的 close project 導航流程已改為先判斷是否為目前 active project，再穩定切到 next project / root route，避免關閉專案時發生不穩定跳轉。
  - desktop sidebar 的 `renderPanel` 改為 keyed `Show` 包裹，確保 project 切換時側欄面板重新掛載到正確狀態。

### Validation

- Analysis evidence:
  - `git fetch origin dev` 成功
  - `refacting-merger_daily_delta(sourceRemote=origin, sourceBranch=dev, targetRef=HEAD)` 已執行
  - 再次以 ledger `docs/events/refactor_processed_commits_20260225.md` 過濾既有處理紀錄後完成可移植性盤點
- Execution evidence:
  - Batch A + Batch B + Batch C（partial）已落地到多個檔案（目前 `git diff --stat`：53 files changed, 961 insertions(+), 308 deletions(-)）：
    - `packages/app/src/context/permission-auto-respond.ts`
    - `packages/app/src/context/permission.tsx`
    - `packages/app/src/components/prompt-input.tsx`
    - `packages/app/src/pages/session/use-session-commands.tsx`
    - `packages/app/src/pages/layout/helpers.ts`
    - `packages/app/src/pages/layout/sidebar-items.tsx`
    - `packages/app/src/pages/session/session-request-tree.ts`
    - `packages/app/src/components/session/session-sortable-tab.tsx`
    - `packages/app/src/pages/session/index.tsx`
    - `packages/app/src/pages/session/session-side-panel.tsx`
    - `packages/desktop/scripts/finalize-latest-json.ts`
    - `packages/desktop/src-tauri/src/lib.rs`
    - `packages/desktop/src/bindings.ts`
    - `packages/desktop/src/index.tsx`
    - `packages/ui/src/components/message-part.css`
    - `packages/ui/src/components/message-part.tsx`
    - `packages/ui/src/components/provider-icon.tsx`
    - `packages/ui/src/components/session-retry.tsx`
    - `packages/ui/src/components/session-review.css`
    - `packages/ui/src/components/session-turn.tsx`
    - `packages/ui/src/components/tabs.css`
    - `packages/ui/src/i18n/{ar,br,bs,da,de,en,es,fr,ja,ko,no,pl,ru,th,zh,zht}.ts`
  - `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
  - `bun test packages/app/src/components/prompt-input/submit.test.ts` 通過（2 pass / 0 fail）
  - 後續補入 `39691e517` 後再次執行 `bun run typecheck`，仍通過（`Tasks: 16 successful, 16 total`）
  - 再補入 `356b5d460` 後再次執行 `bun run typecheck`，仍通過（`Tasks: 16 successful, 16 total`）
- Deferred within Batch A:
  - `session-review.tsx/css` 的 scroll/header upstream 修正先暫緩，因 cms 現況結構不完全同構，避免盲目搬運。
- Deferred for now:
  - `feat(app): show which messages are queued (#15587)`：cms 當前 `session-turn`/`message` 結構與 upstream 不完全同構，需另做結構對齊後再移植。
  - `fix(app): show proper usage limit errors (#15496)` 僅先移植 UI card / locale 子集；若後續試用發現 retry 流程仍有誤，再補 deeper status/render 對齊。
  - `fix(app): provider settings consistency (#4c185c70f)`：deferred。upstream 依賴 `opencode-go` provider note / icon / settings copy 管線；cms 目前缺完整對應 i18n + provider-icon 資產，且涉及 admin/control-plane 產品決策，不做半套移植。
  - provider connect payload rename（`providerId` → `providerID`）：deferred by contract。cms 當前 SDK/client 型別仍以 `providerId` 為準，直接改 payload 會破壞型別與 API 合約，需待 SDK surface 先一致化。
  - session/router hash cleanup：deferred as medium-low risk follow-up。cms 目前已在 `use-session-hash-scroll.ts` 內具備等價 helper（`messageIdFromHash`），但若要再進一步抽離到 router/useLocation 方案，會落入較大的 session split/refactor wave，非尾差等級 patch。
  - model-management UI wave（`dialog-manage-models.tsx` / `settings-models.tsx`）: current cms already reflects the upstream eye-toggle/header styling direction. Remaining diff is mostly historical churn/import-level residue or part of older UX cleanup, no additional behavior-port required in this pass.
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪新增的是 app 端 permission auto-accept 狀態管理與 pre-session UX，未改動 runtime 架構邊界、provider/account/session contracts。
