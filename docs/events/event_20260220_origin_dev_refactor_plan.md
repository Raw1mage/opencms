# Refactor Plan: 2026-02-20 (origin/dev → HEAD, origin_dev_delta_20260220)

Date: 2026-02-20
Status: IN_PROGRESS

## Summary

- Upstream pending (raw): 464 commits
- Excluded by processed ledger: 0 commits
- Commits for this round: 464 commits

## Round Notes (2026-02-20)

- 原則確認：僅做「分析後重構移植」，不直接 merge `origin/dev` commits 到 `cms`。
- 先聚焦最新 upstream 高價值低侵入修復，避免影響 cms 既有框架。
- 本輪已先行重構移植：
  - `93615bef2` fix(cli): missing plugin deps cause TUI black screen
  - `ac0b37a7b` fix(snapshot): respect info exclude in snapshot staging
  - `241059302` fix(github): support variant in github action and opencode github run
- 暫緩：
  - `7e681b0bc`（prompt large paste）與 `4e9ef3ecc`（terminal issues）涉及 `packages/app` 區塊，需額外做 cms UI/互動相容性驗證後再決策。

### Round 2 Update (2026-02-20)

- 已完成 app 層相容性移植：
  - `7e681b0bc`：prompt-input 大量貼上卡頓修復（large paste fast-path + fragment 換行上限保護）。
  - `4e9ef3ecc`：terminal lifecycle 修復（ws 正常關閉碼、僅渲染 active terminal、focus 延後至 next tick）。
- 保留差異（未直接照抄 upstream）：
  - `packages/opencode/src/pty/index.ts` 的 token 比對邏輯未移植，因 cms 既有 socket-id subscriber 隔離機制已覆蓋同類問題，避免重疊重構風險。
- 驗證：
  - `bun turbo typecheck --filter @opencode-ai/app` ✅
  - 直接跑 DOM 單測在當前 CLI 環境缺少 `document`（非本次變更回歸）；未阻斷本輪移植。

### Round 3 Update (2026-02-20)

- 已移植 `packages/ui` 兩個低風險 UI 修正：
  - `1de12604c`：root workspace (`/` 或 `\`) 下路徑相對化保護，避免把整段字串清空。
  - `7e1051af0`：turn duration 改以該 turn 內 assistant messages 的最大 completed 時間計算，顯示完整回合耗時。
- 驗證：
  - `bun turbo typecheck --filter @opencode-ai/ui` ✅

### Round 4 Update (2026-02-20)

- 已移植 `7419ebc87`（experimental 全域 session list）到 cms 現行 storage 架構：
  - `Session.listGlobal()`：跨專案列舉 session，支援 `directory/roots/start/cursor/search/limit/archived`。
  - `GET /experimental/session`：回傳 `Session.GlobalInfo[]`，並支援 `x-next-cursor` 分頁。
  - 補上 server test：`packages/opencode/test/server/global-session-list.test.ts`（跨專案 metadata、archived 過濾、cursor 分頁）。
- 驗證：
  - `bun test packages/opencode/test/server/global-session-list.test.ts` ✅
  - `bun turbo typecheck --filter opencode` ✅

### Round 5 Update (2026-02-20)

- 已移植 `1c2416b6d`（desktop：若 default server 已是 localhost，不再額外啟 sidecar）：
  - Rust 端 `ServerReadyData` 擴充 `username` / `is_sidecar`，前端可辨識是否 sidecar 連線。
  - 連線策略調整：custom/default URL 健康且為 localhost 時直接使用 existing server；remote URL 則保留 sidecar fallback。
  - `server::check_health` timeout 由 3s 提高到 7s，並新增 `is_localhost_url` helper。
  - Desktop bindings 與 `index.tsx` 已同步。
- 驗證：
  - `bun turbo typecheck --filter @opencode-ai/desktop` ✅
  - `cargo check` ✅（安裝 rust/cargo、GTK/WebKit 依賴並補齊 sidecar 後已通過）

### Round 6 Update (2026-02-20)

- 已移植 `1a329ba47`（tui prompt history/stash 因 structuredClone + store proxy 造成不穩）：
  - `prompt/history.tsx` 與 `prompt/stash.tsx` 改用 `structuredClone(unwrap(...))`。
  - 移除 `remeda.clone` 在此處的依賴，避免 Solid store proxy 物件被直接 clone 帶來邊界問題。
- 驗證：
  - `bun turbo typecheck --filter opencode` ✅

### Round 7 Update (2026-02-20)

- 依使用者指示一次盤點並完成 A 組 6 個 behavioral-fix 重構點：
  - `81b5a6a08` workspace reset
  - `81ca2df6a` randomUUID insecure context guard
  - `ed472d8a6` defensive session context metrics
  - `a82ca8600` defensive code component
  - `0771e3a8b` preserve undo history for plain-text paste
  - `ff0abacf4` project icons unloading
- 結果：cms 現況已涵蓋上述修正（本輪以審核驗證 + ledger 記錄為主，無需額外程式碼補丁）。
- 完整測試：
  - `bun turbo typecheck --filter @opencode-ai/app` ✅
  - `bun turbo typecheck --filter @opencode-ai/ui` ✅
  - `bun test packages/app/src/utils/uuid.test.ts packages/app/src/components/session/session-context-metrics.test.ts` ✅
  - `bun run --cwd /home/pkcs12/projects/opencode/packages/app test:unit` ✅（227 pass / 5 skip / 0 fail）
- 文件化：
  - 已更新 `docs/events/refactor_processed_commits_20260220.md` round7。
  - 架構層面無新增邊界變動，`ARCHITECTURE.md` 本輪無需更新。

### Round 8 Update (2026-02-20)

- 依 B 類順序完成 4 個中風險重構點：
  - `624dd94b5`：tool output 訊息調整為更具操作性的 LLM 友善文案（edit/glob/grep）。
  - `ba54cee55`：webfetch 對非 SVG image 回傳 file attachments（data URL）而非文字解碼。
  - `3befd0c6c`：MCP tools 探測改為並行 `Promise.all` 拉取 `listTools()`。
  - `56ad2db02`：`tool.execute.after` hook input 新增 `args`（plugin 可見原始工具參數）。
- 額外對齊：
  - 新增 `packages/opencode/test/tool/webfetch.test.ts`（image/svg/text 三情境覆蓋）。
  - `ARCHITECTURE.md` 已補記 plugin hook 契約與 webfetch 二進位附件路徑變更。
- 完整測試（B 類範圍）：
  - `bun turbo typecheck --filter opencode --filter @opencode-ai/plugin` ✅
  - `bun test packages/opencode/test/tool/grep.test.ts packages/opencode/test/tool/webfetch.test.ts` ⚠️ `grep` 既有測試在當前倉庫內容量下仍觸發 output redirect（1 fail），`webfetch` 新增測試全過。
  - `bun test packages/opencode/test/tool` ⚠️ 存在多個既有/環境性失敗（skill/registry/read/grep），非本輪 B 類新增變更引入。

### Round 9 Update (2026-02-20)

- 依「剩餘重點」建議執行高優先 app/ui 批次盤點（10 項）：
  - `958320f9c`, `50f208d69`, `0303c29e3`, `7f95cc64c`, `c9719dff7`, `dec304a27`, `dd296f703`, `1c71604e0`, `d30e91738`, `ebb907d64`。
- 結果：
  - 9 項已由先前 cms 重構涵蓋（本輪標記 integrated）。
  - 1 項需補移植：`d30e91738`（inline code URL auto-link + hover 提示），已完成 port。
- 驗證：
  - `bun turbo typecheck --filter @opencode-ai/app --filter @opencode-ai/ui` ✅
  - `bun run --cwd /home/pkcs12/projects/opencode/packages/app test:unit` ✅（227 pass / 5 skip / 0 fail）
- 文件化：
  - 已更新 `docs/events/refactor_processed_commits_20260220.md` round9（10 筆：9 integrated + 1 ported）。
  - 本輪無新增跨模組架構邊界，`ARCHITECTURE.md` 無需更新。

### Round 10 Update (2026-02-20)

- 依 P1 計畫執行三個中風險重構點：
  - `548608b7a` terminal pty isolation
  - `8da5fd0a6` worktree delete
  - `d01890388` malformed tool input crash
- 結果：
  - `548608b7a`、`8da5fd0a6`：cms 已先前涵蓋（本輪標記 integrated）。
  - `d01890388`：完成 port（`packages/opencode/src/cli/cmd/run.ts` 工具分派加入 try/catch，異常時回退 fallback）。
- 驗證：
  - `bun turbo typecheck --filter opencode` ✅
  - `bun test packages/opencode/test/pty/pty-output-isolation.test.ts packages/opencode/test/project/worktree-remove.test.ts` ✅
- 文件化：
  - 已更新 `docs/events/refactor_processed_commits_20260220.md` round10（2 integrated + 1 ported）。
  - 本輪無新增架構邊界，`ARCHITECTURE.md` 無需更新。

### Round 11 Update (2026-02-20)

- 依 P2 計畫執行四個重構點：
  - `29671c139` token substitution in `OPENCODE_CONFIG_CONTENT`
  - `98aeb60a7` ensure @ directory uses Read tool
  - `67c985ce8` WAL checkpoint on database open
  - `179c40749` websearch description cache-bust tweak
- 結果：
  - `29671c139`、`98aeb60a7`：cms 已先前涵蓋（標記 integrated）。
  - `67c985ce8`：當前 cms 為 file-storage 架構，無 `src/storage/db.ts` SQLite runtime 路徑，標記 skipped（不適用）。
  - `179c40749`：完成 port（websearch 描述由 `{{date}}` 改為 `{{year}}`，避免每日 cache bust）。
- 驗證：
  - `bun turbo typecheck --filter opencode` ✅
  - `bun test packages/opencode/test/config/config.test.ts -t "OPENCODE_CONFIG_CONTENT token substitution"` ✅
  - `bun test packages/opencode/test/config/config.test.ts` ⚠️ 多項既有失敗（與本輪 websearch 文案改動無直接關聯）。
- 文件化：
  - 已更新 `docs/events/refactor_processed_commits_20260220.md` round11（2 integrated + 1 skipped + 1 ported）。
  - 本輪無新增架構邊界，`ARCHITECTURE.md` 無需更新。

### Round 12 Update (2026-02-20)

- 依 Round 12 計畫執行兩個 CLI 功能重構點：
  - `693127d38` run `--dir`
  - `b0afdf6ea` session delete command
- 結果：
  - `693127d38`：完成 port（`run` 支援 `--dir`；本地模式切換 cwd，attach 模式傳遞 remote directory）。
  - `b0afdf6ea`：完成 port（新增 `session delete <sessionID>`，含存在性檢查與成功訊息）。
- 驗證：
  - `bun turbo typecheck --filter opencode` ✅
  - `bun test packages/opencode/test/session/session.test.ts` ⚠️ 既有 timeout/flaky（session.started event），非本輪 CLI 參數/子命令變更直接回歸。
- 文件化：
  - 已更新 `docs/events/refactor_processed_commits_20260220.md` round12（2 ported）。
  - 本輪無新增跨模組架構邊界，`ARCHITECTURE.md` 無需更新。

### Round 13 Planning Update (2026-02-20)

- 使用者指示忽略候選 1/2/3/4/5/6/8/9，下一階段僅評估：
  - `e269788a8` structured outputs (session/llm/sdk contract)
  - `a580fb47d` attachment ID ownership shift (tool -> prompt)
- 盤點結論：
  - 兩者屬同一條高風險主線（訊息/工具輸出協定重構），不建議拆成零碎 patch，應以單一專案階段處理。
  - 現況觀察：`Tool` 型別已改為 attachment 不含 id/sessionID/messageID，但 `webfetch` 等工具仍在工具層填 ID；表示 pipeline 正處於混合態，需要一致化遷移。
- 建議執行策略（先設計後實作）：
  1. 先完成「attachment ownership 一致化」：所有 tool attachments 移除 ID/Session metadata，由 prompt 單點注入。
  2. 再導入 structured output：Message schema、prompt toolChoice、error/retry contract、SDK v2 參數同步。
  3. 最後補全整合測試矩陣（tool attachments + structured output + resume/retry）。

### Round 13 Execution Update (2026-02-20)

- 已執行 Phase S1（attachment ownership 一致化）第一步：
  - `packages/opencode/src/tool/webfetch.ts`：移除工具層 attachment `id/sessionID/messageID` 注入。
  - `packages/opencode/src/tool/batch.ts`：batch 對外回傳附件改用原始 tool output（不再回傳已注入 id 的附件）；內部子工具狀態 persistence 仍保留 session part metadata。
- 驗證：
  - `bun turbo typecheck --filter opencode` ✅
  - `bun test packages/opencode/test/tool/webfetch.test.ts packages/opencode/test/tool/read.test.ts` ⚠️ webfetch 全綠；read 存在既有 AGENTS metadata 測試失敗（與本輪附件 ownership 變更無直接關聯）。
- 下一步（未實作）：
  - 將 remaining attachment 相關路徑完全收斂到 prompt/processor 單點注入，再進入 structured outputs (`e269788a8`) 主線。

### Round 14 Execution Update (2026-02-20)

- 已執行 structured outputs 主線移植（`e269788a8`）之核心契約層：
  - `MessageV2`：新增 `format`（user message）、`structured`（assistant message）、`StructuredOutputError`。
  - `SessionPrompt`：新增 `format` 輸入；`json_schema` 模式下注入 `StructuredOutput` tool + required toolChoice；若模型未產生結構化輸出則回寫 `StructuredOutputError`。
  - `LLM`：stream input 支援 `toolChoice` 並傳入 provider streamText。
  - SDK v2 generated types/client：新增 `OutputFormat`、error union 與 `prompt/promptAsync` 的 `format` body 參數。
  - 新增測試：`packages/opencode/test/session/structured-output.test.ts`（format persistence + StructuredOutput tool capture）。
- 驗證：
  - `bun turbo typecheck --filter opencode --filter @opencode-ai/sdk` ✅
  - `bun test packages/opencode/test/session/message-v2.test.ts` ✅
  - `bun test packages/opencode/test/session/structured-output.test.ts` ✅
- 備註：
  - 尚未補齊 end-to-end integration（含 resume/retry/compaction 交互）覆蓋，保留於後續 round 擴充。

### Round 14.1 Convergence Update (2026-02-20)

- 針對 remaining attachment ownership 路徑完成收斂：
  - 新增 `session/attachment-ownership.ts`，以 `materializeToolAttachments()` 單點注入 `id/sessionID/messageID`。
  - `SessionProcessor` 的 tool-result attachment 注入改用共用 helper。
  - `SessionPrompt` subtask tool-result attachment 注入改用共用 helper。
- 效果：
  - 附件身份欄位分配規則由「多點內嵌 map」收斂為「session 層共用函式」，降低後續 structured output 與 tool pipeline 演進時的分岔風險。
- 驗證：
  - `bun turbo typecheck --filter opencode` ✅
  - `bun test packages/opencode/test/tool/webfetch.test.ts packages/opencode/test/session/message-v2.test.ts packages/opencode/test/session/structured-output.test.ts` ✅

### Round 15 Update (2026-02-21)

- 依使用者指示啟動 P0（Structured Outputs 整合覆蓋）並完成測試擴充：
  - `packages/opencode/test/session/structured-output.test.ts` 新增整合案例：
    - structured tool-call 路徑（含 `toolChoice: "required"` 驗證）
    - 純文字回覆未產生 structured output 路徑
    - retry 後仍可完成 structured output
    - 非阻塞 async prompt 呼叫路徑
- 修正一個流程缺口：
  - `packages/opencode/src/session/prompt.ts`
  - 當 `format=json_schema` 且 assistant 已完成回覆但未產生 structured output 時，於 loop 提前結束分支補寫 `StructuredOutputError`，避免無錯誤訊號直接退出。
- 驗證：
  - `bun test packages/opencode/test/session/structured-output.test.ts` ✅
  - `bun turbo typecheck --filter opencode` ✅

### Round 15.2 Update (2026-02-21)

- 依使用者指示擴充 P0 第二階段（resume/compaction 交互）：
  - `packages/opencode/test/session/structured-output.test.ts` 新增案例：
    - auto-compaction 後仍可維持 `json_schema` structured output 流程
    - follow-up turn（resume）後，前一回合 `structured` 欄位仍保留
- 修正 compaction continuation 的 format 傳遞缺口：
  - `packages/opencode/src/session/compaction.ts`
    - `SessionCompaction.create()` 新增/保留 `format`
    - auto continue synthetic user message 繼承 `format`
  - `packages/opencode/src/session/prompt.ts`
    - 觸發 `SessionCompaction.create()` 時傳遞 `lastUser.format`
- 效果：
  - structured-output 請求在 compaction 迴圈內不再掉回純文字流程。
- 驗證：
  - `bun test packages/opencode/test/session/structured-output.test.ts` ✅（8 pass）
  - `bun turbo typecheck --filter opencode` ✅

### Round 16 Test Alignment Update (2026-02-21)

- 依使用者指示先做「修測試」而非調整 runtime：
  - `packages/opencode/test/session/compaction.test.ts`
  - 將 `returns false when compaction.auto is disabled` 改為
    `ignores project-local compaction.auto when project config is disabled`。
- 原因：
  - cms runtime 已明確關閉 project-level config merge（`config.ts` 內 `projectConfigEnabled=false`），
    故測試中寫入專案根 `opencode.json` 的 `compaction.auto=false` 不應影響 `isOverflow()`。
- 效果：
  - 測試語意與現行架構契約一致，避免將「架構既定行為」誤判為 regression。

## Actions

| Commit      | Logical Type   | Value Score   | Risk   | Decision   | Notes                                                                                                                                            |
| :---------- | :------------- | :------------ | :----- | :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| `81b5a6a08` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app):workspace reset (#13170)                                                                                                                |
| `8f56ed5b8` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                                  |
| `fbabce112` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): translations                                                                                                                           |
| `6b30e0b75` | docs           | 1/-1/-1/1=0   | low    | skipped    | chore: update docs sync workflow                                                                                                                 |
| `e3471526f` | feature        | 1/0/0/1=2     | low    | integrated | add square logo variants to brand page                                                                                                           |
| `6b4d617df` | feature        | 1/0/0/0=1     | medium | skipped    | feat: adjust read tool so that it can handle dirs too (#13090)                                                                                   |
| `006d673ed` | feature        | 1/0/0/0=1     | medium | skipped    | tweak: make read tool offset 1 indexed instead of 0 to avoid confusion that could be caused by line #s being 1 based (#13198)                    |
| `e2a33f75e` | infra          | 1/0/0/1=2     | low    | integrated | Update VOUCHED list                                                                                                                              |
| `8c7b35ad0` | feature        | 1/0/0/0=1     | medium | skipped    | tweak: compaction check (#13214)                                                                                                                 |
| `125727d09` | feature        | 1/0/0/1=2     | low    | integrated | upgrade opentui to 0.1.79 (#13036)                                                                                                               |
| `264dd213f` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `c856f875a` | infra          | 1/0/0/1=2     | low    | integrated | chore: upgrade bun to 1.3.9 (#13223)                                                                                                             |
| `8577eb8ec` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `3befd0c6c` | feature        | 1/0/0/0=1     | medium | skipped    | tweak: use promise all for mcp listTools calls (#13229)                                                                                          |
| `8eea53a41` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs(ar): second-pass localization cleanup                                                                                                       |
| `aea68c386` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(docs): locale translations for nav elements and headings                                                                                     |
| `81ca2df6a` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): guard randomUUID in insecure browser contexts (#13237)                                                                                 |
| `bf5a01edd` | feature        | 0/0/0/-1=-1   | high   | skipped    | feat(opencode): Venice Add automatic variant generation for Venice models (#12106)                                                               |
| `135f8ffb2` | ux             | 0/0/0/-1=-1   | high   | skipped    | feat(tui): add toggle to hide session header (#13244)                                                                                            |
| `5bdf1c4b9` | infra          | 1/0/0/1=2     | low    | integrated | Update VOUCHED list                                                                                                                              |
| `ad2087094` | feature        | 0/0/0/-1=-1   | high   | skipped    | support custom api url per model                                                                                                                 |
| `66780195d` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                                  |
| `e269788a8` | feature        | 0/0/0/-1=-1   | high   | skipped    | feat: support claude agent SDK-style structured outputs in the OpenCode SDK (#8161)                                                              |
| `f6e7aefa7` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                                  |
| `8f9742d98` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix(win32): use ffi to get around bun raw input/ctrl+c issues (#13052)                                                                           |
| `03de51bd3` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.60                                                                                                                                 |
| `d86f24b6b` | feature        | 1/0/0/1=2     | low    | integrated | zen: return cost                                                                                                                                 |
| `624dd94b5` | feature        | 1/0/0/0=1     | medium | skipped    | tweak: tool outputs to be more llm friendly (#13269)                                                                                             |
| `1413d77b1` | feature        | 1/0/0/1=2     | low    | integrated | desktop: sqlite migration progress bar (#13294)                                                                                                  |
| `0eaeb4588` | feature        | 1/0/0/1=2     | low    | integrated | Testing SignPath Integration (#13308)                                                                                                            |
| `fa97475ee` | infra          | 1/0/0/1=2     | low    | integrated | ci: move test-sigining policy                                                                                                                    |
| `5f421883a` | infra          | 1/0/0/1=2     | low    | integrated | chore: style loading screen                                                                                                                      |
| `ecb274273` | feature        | 1/0/0/1=2     | low    | integrated | wip(ui): diff virtualization (#12693)                                                                                                            |
| `9f9f0fb8e` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `d72314708` | infra          | 1/0/0/1=2     | low    | integrated | feat: update to not post comment on workflows when no duplicates found (#13238)                                                                  |
| `d82d22b2d` | feature        | 1/0/0/1=2     | low    | integrated | wip: zen                                                                                                                                         |
| `a11556505` | feature        | 0/0/0/-1=-1   | high   | skipped    | core: allow model configurations without npm/api provider details                                                                                |
| `892bb7526` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.61                                                                                                                                 |
| `85df10671` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                                  |
| `ae811ad8d` | feature        | 1/0/0/1=2     | low    | integrated | wip: zen                                                                                                                                         |
| `56ad2db02` | feature        | 1/0/0/0=1     | medium | skipped    | core: expose tool arguments in shell hook for plugin visibility                                                                                  |
| `ff4414bb1` | infra          | 1/0/0/1=2     | low    | integrated | chore: refactor packages/app files (#13236)                                                                                                      |
| `ed472d8a6` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): more defensive session context metrics                                                                                                 |
| `a82ca8600` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): more defensive code component                                                                                                          |
| `658bf6fa5` | docs           | -1/-1/-1/1=-2 | low    | skipped    | zen: minimax m2.5                                                                                                                                |
| `59a323e9a` | docs           | -1/-1/-1/1=-2 | low    | skipped    | wip: zen                                                                                                                                         |
| `ecab692ca` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(docs): correct `format` attribute in `StructuredOutputs` (#13340)                                                                            |
| `2db618dea` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix: downgrade bun to 1.3.5 (#13347)                                                                                                             |
| `847e06f9e` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `ba54cee55` | feature        | 1/0/0/0=1     | medium | skipped    | feat(tool): return image attachments from webfetch (#13331)                                                                                      |
| `789705ea9` | docs           | -1/-1/-1/1=-2 | low    | skipped    | ignore: document test fixtures for agents                                                                                                        |
| `da952135c` | feature        | 1/0/0/1=2     | low    | integrated | chore(app): refactor for better solidjs hygiene (#13344)                                                                                         |
| `0771e3a8b` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): preserve undo history for plain-text paste (#13351)                                                                                    |
| `ff0abacf4` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): project icons unloading                                                                                                                |
| `aaee5fb68` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.62                                                                                                                                 |
| `e6e9c15d3` | feature        | 1/0/0/0=1     | medium | skipped    | improve codex model list                                                                                                                         |
| `ac018e3a3` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.63                                                                                                                                 |
| `d1ee4c8dc` | feature        | 1/0/0/1=2     | low    | integrated | test: add more test cases for project.test.ts (#13355)                                                                                           |
| `958320f9c` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): remote http server connections                                                                                                         |
| `50f208d69` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): suggestion active state broken                                                                                                         |
| `3696d1ded` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `81c623f26` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `e9b9a62fe` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `7ccf223c8` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `70303d0b4` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `ff3b174c4` | protocol       | 1/0/0/1=2     | low    | integrated | fix(app): normalize oauth error messages                                                                                                         |
| `4e0f509e7` | feature        | 1/0/0/1=2     | low    | integrated | feat(app): option to turn off sound effects                                                                                                      |
| `548608b7a` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(app): terminal pty isolation                                                                                                                 |
| `11dd281c9` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs: update STACKIT provider documentation with typo fix (#13357)                                                                               |
| `20dcff1e2` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                                  |
| `c0814da78` | ux             | 0/0/0/-1=-1   | high   | skipped    | do not open console on error (#13374)                                                                                                            |
| `a8f288452` | ux             | 0/0/0/-1=-1   | high   | skipped    | feat: windows selection behavior, manual ctrl+c (#13315)                                                                                         |
| `4018c863e` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix: baseline CPU detection (#13371)                                                                                                             |
| `445e0d767` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `93eee0daf` | behavioral-fix | 0/1/0/-1=0    | high   | ported     | fix: look for recent model in fallback in cli (#12582)                                                                                           |
| `d475fd613` | infra          | 0/0/0/-1=-1   | high   | skipped    | chore: generate                                                                                                                                  |
| `f66624fe6` | infra          | 1/0/0/0=1     | medium | skipped    | chore: cleanup flag code (#13389)                                                                                                                |
| `29671c139` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: token substitution in OPENCODE_CONFIG_CONTENT (#13384)                                                                                      |
| `76db21867` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.64                                                                                                                                 |
| `991496a75` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: resolve ACP hanging indefinitely in thinking state on Windows (#13222)                                                                      |
| `adb0c4d4f` | feature        | 1/0/0/1=2     | low    | integrated | desktop: only show loading window if sqlite migration is necessary                                                                               |
| `0303c29e3` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): failed to create store                                                                                                                 |
| `8da5fd0a6` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(app): worktree delete                                                                                                                        |
| `b525c03d2` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `7f95cc64c` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): prompt input quirks                                                                                                                    |
| `c9719dff7` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): notification should navigate to session                                                                                                |
| `dec304a27` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): emoji as avatar                                                                                                                        |
| `e0f1c3c20` | feature        | 1/0/0/1=2     | low    | integrated | cleanup desktop loading page                                                                                                                     |
| `fb7b2f6b4` | feature        | 1/0/0/1=2     | low    | integrated | feat(app): toggle all provider models                                                                                                            |
| `dd296f703` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): reconnect event stream on disconnect                                                                                                   |
| `b06afd657` | infra          | 1/0/0/1=2     | low    | integrated | ci: remove signpath policy                                                                                                                       |
| `1608565c8` | feature        | 1/0/0/0=1     | medium | skipped    | feat(hook): add tool.definition hook for plugins to modify tool description and parameters (#4956)                                               |
| `98aeb60a7` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: ensure @-ing a dir uses the read tool instead of dead list tool (#13428)                                                                    |
| `1fb6c0b5b` | feature        | 1/0/0/0=1     | medium | skipped    | Revert "fix: token substitution in OPENCODE_CONFIG_CONTENT" (#13429)                                                                             |
| `34ebe814d` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.65                                                                                                                                 |
| `0d90a22f9` | feature        | 0/0/0/-1=-1   | high   | skipped    | feat: update some ai sdk packages and uuse adaptive reasoning for opus 4.6 on vertex/bedrock/anthropic (#13439)                                  |
| `693127d38` | feature        | 1/0/0/0=1     | medium | skipped    | feat(cli): add --dir option to run command (#12443)                                                                                              |
| `b8ee88212` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `ebb907d64` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(desktop): performance optimization for showing large diff & files (#13460)                                                                   |
| `9f20e0d14` | docs           | 1/-1/-1/1=0   | low    | skipped    | fix(web): sync docs locale cookie on alias redirects (#13109)                                                                                    |
| `ebe5a2b74` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): remount SDK/sync tree when server URL changes (#13437)                                                                                 |
| `b1764b2ff` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs: Fix zh-cn translation mistake in tools.mdx (#13407)                                                                                        |
| `f991a6c0b` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                                  |
| `e242fe19e` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(web): use prompt_async endpoint to avoid timeout over VPN/tunnel (#12749)                                                                    |
| `1c71604e0` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): terminal resize                                                                                                                        |
| `4f51c0912` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `b8848cfae` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs(ko): polish Korean phrasing in acp, agents, config, and custom-tools docs (#13446)                                                          |
| `88e2eb541` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs: add pacman installation option for Arch Linux alongside AUR (#13293)                                                                       |
| `bc1fd0633` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(test): move timeout config to CLI flag (#13494)                                                                                              |
| `72c09e1dc` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix: standardize zh-CN docs character set and terminology (#13500)                                                                               |
| `d30e91738` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(ui): support cmd-click links in inline code (#12552)                                                                                         |
| `d01890388` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: prevent opencode run crash on malformed tool inputs (#13051)                                                                                |
| `6d95f0d14` | ux             | 0/0/0/-1=-1   | high   | skipped    | sqlite again (#10597)                                                                                                                            |
| `afb04ed5d` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                                  |
| `7d4687277` | feature        | 1/0/0/1=2     | low    | integrated | desktop: remote OPENCODE_SQLITE env (#13545)                                                                                                     |
| `d0dcffefa` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `0b9e929f6` | feature        | 1/0/0/1=2     | low    | integrated | desktop: fix rust                                                                                                                                |
| `ffc000de8` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.2.0                                                                                                                                  |
| `1e25df21a` | feature        | 1/0/0/1=2     | low    | integrated | zen: minimax m2.5 & glm5                                                                                                                         |
| `179c40749` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: tweak websearch tool description date info to avoid cache busts (#13559)                                                                    |
| `b02075844` | feature        | 1/0/0/0=1     | medium | skipped    | tui: show all project sessions from any working directory                                                                                        |
| `cd775a286` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.2.1                                                                                                                                  |
| `ed439b205` | infra          | 1/0/0/1=2     | low    | integrated | ci: test-signing signpath policy                                                                                                                 |
| `df3203d2d` | infra          | 1/0/0/1=2     | low    | integrated | ci: move signpath policy                                                                                                                         |
| `ef205c366` | feature        | 1/0/0/1=2     | low    | integrated | bump vertex ai packages (#13625)                                                                                                                 |
| `759ec104b` | behavioral-fix | 0/1/0/-1=0    | high   | ported     | fix vercel gateway variants (#13541)                                                                                                             |
| `306fc7707` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `68bb8ce1d` | feature        | 1/0/0/0=1     | medium | skipped    | core: filter sessions at database level to improve session list loading performance                                                              |
| `8631d6c01` | feature        | 1/0/0/1=2     | low    | integrated | core: add comprehensive test coverage for Session.list() filters                                                                                 |
| `3b6b3e6fc` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.2.2                                                                                                                                  |
| `933a491ad` | behavioral-fix | 0/1/0/-1=0    | high   | ported     | fix: ensure vercel variants pass amazon models under bedrock key (#13631)                                                                        |
| `575f2cf2a` | infra          | 1/0/0/1=2     | low    | integrated | chore: bump nixpkgs to get bun 1.3.9 (#13302)                                                                                                    |
| `67c985ce8` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: add WAL checkpoint on database open (#13633)                                                                                                |
| `839c5cda1` | behavioral-fix | 0/1/0/-1=0    | high   | ported     | fix: ensure anthropic models on OR also have variant support (#13498)                                                                            |
| `7911cb62a` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `c190f5f61` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.2.3                                                                                                                                  |
| `460a87f35` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): stack overflow in filetree (#13667)                                                                                                    |
| `85b5f5b70` | feature        | 1/0/0/1=2     | low    | integrated | feat(app): clear notifications action (#13668)                                                                                                   |
| `2bab5e8c3` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: derive all IDs from file paths during json migration                                                                                        |
| `b5c8bd342` | feature        | 1/0/0/1=2     | low    | integrated | test: add tests for path-derived IDs in json migration                                                                                           |
| `45f005037` | feature        | 1/0/0/0=1     | medium | skipped    | core: add db command for database inspection and querying                                                                                        |
| `d1482e148` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.2.4                                                                                                                                  |
| `eb553f53a` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: ensure sqlite migration logs to stderr instead of stdout (#13691)                                                                           |
| `985c2a3d1` | feature        | 1/0/0/1=2     | low    | integrated | feat: Add GeistMono Nerd Font to available mono font options (#13720)                                                                            |
| `3aaa34be1` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(desktop): focus window after update/relaunch (#13701)                                                                                        |
| `376112172` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs: add Ukrainian README translation (#13697)                                                                                                  |
| `878ddc6a0` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): keybind [shift+tab] (#13695)                                                                                                           |
| `3c85cf4fa` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): only navigate prompt history at input boundaries (#13690)                                                                              |
| `cf50a289d` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(desktop): issue viewing new files opened from the file tree (#13689)                                                                         |
| `3a3aa300b` | feature        | 1/0/0/1=2     | low    | integrated | feat(app): localize "free usage exceeded" error & "Add credits" clickable link (#13652)                                                          |
| `62a24c2dd` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.2.5                                                                                                                                  |
| `9b23130ac` | feature        | 1/0/0/0=1     | medium | skipped    | feat(opencode): add `cljfmt` formatter support for Clojure files (#13426)                                                                        |
| `d9363da9e` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(website): correct zh-CN translation of proprietary terms in zen.mdx (#13734)                                                                 |
| `21e077800` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                                  |
| `920255e8c` | feature        | 1/0/0/1=2     | low    | integrated | desktop: use process-wrap instead of manual job object (#13431)                                                                                  |
| `afd0716cb` | feature        | 0/0/0/-1=-1   | high   | skipped    | feat(opencode): Add Venice support in temperature, topP, topK and smallOption (#13553)                                                           |
| `60807846a` | ux             | 1/0/0/1=2     | low    | integrated | fix(desktop): normalize Linux Wayland/X11 backend and decoration policy (#13143)                                                                 |
| `f7708efa5` | feature        | 0/0/0/-1=-1   | high   | skipped    | feat: add openai-compatible endpoint support for google-vertex provider (#10303)                                                                 |
| `089ab9def` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                                  |
| `1d041c886` | behavioral-fix | 0/1/0/-1=0    | high   | ported     | fix: google vertex var priority (#13816)                                                                                                         |
| `3ebf27aab` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(docs): correct critical translation errors in Russian zen page (#13830)                                                                      |
| `45fa5e719` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(core): remove unnecessary per-message title LLM calls (#13804)                                                                               |
| `b055f973d` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `bb30e0685` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix (tui): Inaccurate tips (#13845)                                                                                                              |
| `ef979ccfa` | protocol       | 1/0/0/1=2     | low    | integrated | fix: bump GitLab provider and auth plugin for mid-session token refresh (#13850)                                                                 |
| `8c1af9b44` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `5cc1d6097` | ux             | 0/0/0/-1=-1   | high   | skipped    | feat(cli): add --continue and --fork flags to attach command (#13879)                                                                            |
| `fdad823ed` | feature        | 1/0/0/0=1     | medium | skipped    | feat(cli): add db migrate command for JSON to SQLite migration (#13874)                                                                          |
| `ae6e85b2a` | feature        | 1/0/0/1=2     | low    | integrated | ignore: rm random comment on opencode.jsonc                                                                                                      |
| `16332a858` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix(tui): make use of server dir path for file references in prompts (#13781)                                                                    |
| `160ba295a` | feature        | 1/0/0/0=1     | medium | skipped    | feat(opencode): add `dfmt` formatter support for D language files (#13867)                                                                       |
| `d8c25bfeb` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.2.6                                                                                                                                  |
| `b0afdf6ea` | feature        | 1/0/0/0=1     | medium | skipped    | feat(cli): add session delete command (#13571)                                                                                                   |
| `86e545a23` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(opencode): ACP sessions never get LLM-generated titles (#13095)                                                                              |
| `9d3c81a68` | feature        | 1/0/0/0=1     | medium | skipped    | feat(acp): add opt-in flag for question tool (#13562)                                                                                            |
| `a580fb47d` | feature        | 1/0/0/0=1     | medium | skipped    | tweak: drop ids from attachments in tools, assign them in prompt.ts instead (#13890)                                                             |
| `d93cefd47` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(website): fix site in safari 18 (#13894)                                                                                                     |
| `916361198` | infra          | 1/0/0/1=2     | low    | integrated | ci: fixed apt cache not working in publish.yml (#13897)                                                                                          |
| `0e669b601` | infra          | 1/0/0/1=2     | low    | integrated | ci: use `useblacksmith/stickydisk` on linux runners only (#13909)                                                                                |
| `e35a4131d` | feature        | 1/0/0/0=1     | medium | skipped    | core: keep message part order stable when files resolve asynchronously (#13915)                                                                  |
| `422609722` | infra          | 1/0/0/1=2     | low    | integrated | ci: fixed Rust cache for 'cargo install' in publish.yml (#13907)                                                                                 |
| `ea2d089db` | infra          | 1/0/0/1=2     | low    | integrated | ci: fixed missing if condition (#13934)                                                                                                          |
| `d338bd528` | feature        | 1/0/0/1=2     | low    | integrated | Hide server CLI on windows (#13936)                                                                                                              |
| `ace63b3dd` | docs           | -1/-1/-1/1=-2 | low    | skipped    | zen: glm 5 free                                                                                                                                  |
| `a93a1b93e` | feature        | 1/0/0/1=2     | low    | integrated | wip: zen                                                                                                                                         |
| `ed4e4843c` | infra          | 1/0/0/1=2     | low    | integrated | ci: update triage workflow (#13944)                                                                                                              |
| `0186a8506` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): keep Escape handling local to prompt input on macOS desktop (#13963)                                                                   |
| `8d0a303af` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs(ko): improve Korean translation accuracy and clarity in Zen docs (#13951)                                                                   |
| `4fd3141ab` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs: improve zh-cn and zh-tw documentation translations (#13942)                                                                                |
| `6e984378d` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(docs): correct reversed meaning in Korean plugins logging section (#13945)                                                                   |
| `4eed55973` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                                  |
| `07947bab7` | ux             | 0/0/0/-1=-1   | high   | skipped    | tweak(tui): new session banner with logo and details (#13970)                                                                                    |
| `3dfbb7059` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(app): recover state after sse reconnect and harden sse streams (#13973)                                                                      |
| `10985671a` | feature        | 1/0/0/1=2     | low    | integrated | feat(app): session timeline/turn rework (#13196)                                                                                                 |
| `277c68d8e` | infra          | 1/0/0/1=2     | low    | integrated | chore: app polish (#13976)                                                                                                                       |
| `e273a31e7` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): icon button spacing                                                                                                                   |
| `703d63474` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                                  |
| `9b1d7047d` | feature        | 1/0/0/1=2     | low    | integrated | tweak(app): keep file tree toggle visible                                                                                                        |
| `0cb11c241` | feature        | 1/0/0/1=2     | low    | integrated | tweak(app): reduce titlebar right padding                                                                                                        |
| `d31e9cff6` | feature        | 1/0/0/1=2     | low    | integrated | tweak(app): use weak borders in titlebar actions                                                                                                 |
| `a8669aba8` | ux             | 1/0/0/1=2     | low    | integrated | tweak(app): match titlebar active bg to hover                                                                                                    |
| `8fcfbd697` | feature        | 1/0/0/1=2     | low    | integrated | tweak(app): align titlebar search text size                                                                                                      |
| `ce0844273` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): center titlebar search and soften keybind                                                                                             |
| `98f3ff627` | feature        | 1/0/0/1=2     | low    | integrated | tweak(app): refine titlebar search and open padding                                                                                              |
| `8e243c650` | feature        | 1/0/0/1=2     | low    | integrated | tweak(app): tighten titlebar action padding                                                                                                      |
| `222b6cda9` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): update magnifying-glass icon                                                                                                          |
| `4d5e86d8a` | feature        | 1/0/0/1=2     | low    | integrated | feat(desktop): more e2e tests (#13975)                                                                                                           |
| `7ed449974` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                                  |
| `5a3e0ef13` | ux             | 1/0/0/1=2     | low    | integrated | tweak(ui): show user message meta on hover                                                                                                       |
| `2cac84882` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): use provider catalog names                                                                                                            |
| `14684d8e7` | ux             | 1/0/0/1=2     | low    | integrated | tweak(ui): refine user message hover meta                                                                                                        |
| `57a5d5fd3` | ux             | 1/0/0/1=2     | low    | integrated | tweak(ui): show assistant response meta on hover                                                                                                 |
| `1d78100f6` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): allow full-width user message meta                                                                                                    |
| `652a77655` | feature        | 1/0/0/1=2     | low    | integrated | ui: add clearer 'Copy response' tooltip label for text parts                                                                                     |
| `adfbfe350` | feature        | 1/0/0/1=2     | low    | integrated | tui: increase prompt mode toggle height for better clickability                                                                                  |
| `d055c1cad` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(desktop): avoid sidecar health-check timeout on shell startup (#13925)                                                                       |
| `46739ca7c` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): ui flashing when switching tabs (#13978)                                                                                               |
| `df59d1412` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix: Homepage video section layout shift (#13987)                                                                                                |
| `47435f6e1` | behavioral-fix | 0/1/0/-1=0    | high   | ported     | fix: don't fetch models.dev on completion (#13997)                                                                                               |
| `ea96f898c` | infra          | 1/0/0/1=2     | low    | integrated | ci: rm remap for jlongster since he is in org now (#14000)                                                                                       |
| `b784c923a` | ux             | 0/0/0/-1=-1   | high   | skipped    | tweak(ui): bump button heights and align permission prompt layout                                                                                |
| `2c17a980f` | feature        | 1/0/0/1=2     | low    | integrated | refactor(ui): extract dock prompt shell                                                                                                          |
| `bd3d1413f` | feature        | 1/0/0/1=2     | low    | integrated | tui: add warning icon to permission requests for better visibility                                                                               |
| `26f835cdd` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): icon-interactive-base color change dark mode                                                                                          |
| `a69b339ba` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(ui): use icon-strong-base for active titlebar icon buttons                                                                                   |
| `0bc1dcbe1` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): update icon transparency                                                                                                              |
| `ce7484b4f` | feature        | 1/0/0/1=2     | low    | integrated | tui: fix share button text styling to use consistent 12px regular font weight                                                                    |
| `a685e7a80` | ux             | 1/0/0/1=2     | low    | integrated | tui: show monochrome file icons by default in tree view, revealing colors on hover to reduce visual clutter and help users focus on code content |
| `737990356` | feature        | 1/0/0/1=2     | low    | integrated | tui: improve modified file visibility and button spacing                                                                                         |
| `4025b655a` | feature        | 1/0/0/1=2     | low    | integrated | desktop: replicate tauri-plugin-shell logic (#13986)                                                                                             |
| `fb79dd7bf` | protocol       | 1/0/0/0=1     | medium | skipped    | fix: Invalidate oauth credentials when oauth provider says so (#14007)                                                                           |
| `20f43372f` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): terminal disconnect and resync (#14004)                                                                                                |
| `3a505b269` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): virtualizer getting wrong scroll root                                                                                                  |
| `7a66ec6bc` | docs           | -1/-1/-1/1=-2 | low    | skipped    | zen: sonnet 4.6                                                                                                                                  |
| `bab3124e8` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): prompt input quirks                                                                                                                    |
| `92912219d` | feature        | 1/0/0/1=2     | low    | integrated | tui: simplify prompt mode toggle icon colors via CSS and tighten message timeline padding                                                        |
| `4ccb82e81` | protocol       | 1/0/0/0=1     | medium | skipped    | feat: surface plugin auth providers in the login picker (#13921)                                                                                 |
| `2a2437bf2` | infra          | 1/0/0/0=1     | medium | skipped    | chore: generate                                                                                                                                  |
| `c1b03b728` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: make read tool more mem efficient (#14009)                                                                                                  |
| `d327a2b1c` | feature        | 1/0/0/1=2     | low    | integrated | chore(app): use radio group in prompt input (#14025)                                                                                             |
| `26c7b240b` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `e345b89ce` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): better tool call batching                                                                                                              |
| `cb88fe26a` | infra          | 1/0/0/0=1     | medium | skipped    | chore: add missing newline (#13992)                                                                                                              |
| `3b9758062` | feature        | 1/0/0/0=1     | medium | skipped    | tweak: ensure read tool uses fs/promises for all paths (#14027)                                                                                  |
| `bad394cd4` | infra          | 1/0/0/1=2     | low    | integrated | chore: remove leftover patch (#13749)                                                                                                            |
| `5512231ca` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix(tui): style scrollbox for permission and sidebar (#12752)                                                                                    |
| `ad3c19283` | ux             | 0/0/0/-1=-1   | high   | skipped    | tui: exit cleanly without hanging after session ends                                                                                             |
| `bca793d06` | docs           | -1/-1/-1/1=-2 | low    | skipped    | ci: ensure triage adds acp label (#14039)                                                                                                        |
| `a344a766f` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                                  |
| `c56f4aa5d` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: simplify redundant ternary in updateMessage (#13954)                                                                                   |
| `ad92181fa` | feature        | 0/0/0/-1=-1   | high   | skipped    | feat: add Kilo as a native provider (#13765)                                                                                                     |
| `572a037e5` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                                  |
| `0ca75544a` | behavioral-fix | 0/1/0/-1=0    | high   | ported     | fix: dont autoload kilo (#14052)                                                                                                                 |
| `25f3eef95` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: ensure explore subagent has external_directory perm set to ask instead of auto denying (#14060)                                             |
| `1109a282e` | infra          | 1/0/0/1=2     | low    | integrated | ci: add nix-eval workflow for cross-platform flake evaluation (#12175)                                                                           |
| `e96f6385c` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(opencode): fix Clojure syntax highlighting (#13453)                                                                                          |
| `6eb043aed` | infra          | 1/0/1/1=3     | low    | integrated | ci: allow commits on top of beta PRs (#11924)                                                                                                    |
| `5aeb30534` | feature        | 1/0/0/1=2     | low    | integrated | desktop: temporarily disable wsl                                                                                                                 |
| `6cd3a5902` | feature        | 1/0/0/1=2     | low    | integrated | desktop: cleanup                                                                                                                                 |
| `3394402ae` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `cc86a64bb` | feature        | 1/0/0/1=2     | low    | integrated | tui: simplify mode toggle icon styling                                                                                                           |
| `c34ad7223` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `fbe9669c5` | ux             | 1/0/0/1=2     | low    | integrated | fix: use group-hover for file tree icon color swap at all nesting levels                                                                         |
| `e132dd2c7` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `e4b548fa7` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs: add policy about AI-generated security reports                                                                                             |
| `00c238777` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup (#14113)                                                                                                                          |
| `2611c35ac` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): lower threshold for diff hiding                                                                                                        |
| `1bb857417` | feature        | 1/0/0/1=2     | low    | integrated | app: refactor server management backend (#13813)                                                                                                 |
| `6b29896a3` | feature        | 1/0/0/0=1     | medium | skipped    | feat: Add centralized filesystem module for Bun.file migration (#14117)                                                                          |
| `3aaf29b69` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `4a5823562` | feature        | 1/0/0/1=2     | low    | integrated | desktop: fix isLocal                                                                                                                             |
| `f8904e397` | feature        | 1/0/0/1=2     | low    | integrated | desktop: handle sidecar key in projectsKey                                                                                                       |
| `d27dbfe06` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(cli): session list --max-count not honored, shows too few sessions (#14162)                                                                  |
| `83b7d8e04` | feature        | 1/0/0/1=2     | low    | integrated | feat: GitLab Duo - bump gitlab-ai-provider to 3.6.0 (adds Sonnet 4.6) (#14115)                                                                   |
| `fc1addb8f` | docs           | -1/-1/-1/1=-2 | low    | skipped    | ignore: tweak contributing md (#14168)                                                                                                           |
| `38572b817` | feature        | 1/0/0/0=1     | medium | skipped    | feat: add Julia language server support (#14129)                                                                                                 |
| `37b24f487` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate index.ts from Bun.file() to Filesystem module (#14160)                                                                         |
| `91a3ee642` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `3d189b42a` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate file/ripgrep.ts from Bun.file()/Bun.write() to Filesystem module (#14159)                                                      |
| `a5c15a23e` | feature        | 1/0/0/0=1     | medium | skipped    | core: allow readJson to be called without explicit type parameter                                                                                |
| `472d01fba` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate cli/cmd/run.ts from Bun.file() to Filesystem/stat modules (#14155)                                                             |
| `b714bb21d` | infra          | 1/0/0/1=2     | low    | integrated | ci: switch to standard GitHub cache action for Bun dependencies                                                                                  |
| `a500eaa2d` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate format/formatter.ts from Bun.file() to Filesystem module (#14153)                                                              |
| `82a323ef7` | feature        | 1/0/0/1=2     | low    | integrated | refactor: migrate cli/cmd/github.ts from Bun.write() to Filesystem module (#14154)                                                               |
| `ef155f376` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate file/index.ts from Bun.file() to Filesystem module (#14152)                                                                    |
| `8f4a72c57` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate config/markdown.ts from Bun.file() to Filesystem module (#14151)                                                               |
| `e0e8b9438` | feature        | 1/0/0/1=2     | low    | integrated | refactor: migrate uninstall.ts from Bun.file()/Bun.write() to Filesystem module (#14150)                                                         |
| `c88ff3c08` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/bun/index.ts from Bun.file()/Bun.write() to Filesystem module (#14147)                                                     |
| `eb3f33769` | ux             | 0/0/0/-1=-1   | high   | skipped    | refactor: migrate clipboard.ts from Bun.file() to Filesystem module (#14148)                                                                     |
| `5638b782c` | ux             | 0/0/0/-1=-1   | high   | skipped    | refactor: migrate editor.ts from Bun.file()/Bun.write() to Filesystem module (#14149)                                                            |
| `d447b7694` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(github): emit PROMPT_TOO_LARGE error on context overflow (#14166)                                                                            |
| `3f60a6c2a` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `ef14f64f9` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `8408e4702` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `72c12d59a` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `be2e6f192` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix(opencode): update pasteImage to only increment count when the previous attachment is an image too (#14173)                                   |
| `8bf06cbcc` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/global/index.ts from Bun.file() to Filesystem module (#14146)                                                              |
| `24a984132` | feature        | 1/0/0/1=2     | low    | integrated | zen: update sst version                                                                                                                          |
| `c6bd32000` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `42aa28d51` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup (#14181)                                                                                                                          |
| `1133d87be` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `de25703e9` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(app): terminal cross-talk (#14184)                                                                                                           |
| `1aa18c6cd` | feature        | 1/0/0/0=1     | medium | skipped    | feat(plugin): pass sessionID and callID to shell.env hook input (#13662)                                                                         |
| `2d7c9c969` | infra          | 1/0/0/0=1     | medium | skipped    | chore: generate                                                                                                                                  |
| `d6331cf79` | feature        | 1/0/0/1=2     | low    | integrated | Update colors.css                                                                                                                                |
| `12016c8eb` | feature        | 1/0/0/1=2     | low    | integrated | oc-2 theme init                                                                                                                                  |
| `5d69f0028` | feature        | 1/0/0/1=2     | low    | integrated | button style tweaks                                                                                                                              |
| `24ce49d9d` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(ui): add previous smoke colors                                                                                                               |
| `0888c0237` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): file tree background color                                                                                                            |
| `9110e6a2a` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): share button border                                                                                                                   |
| `f20c0bffd` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): unify titlebar expanded button background                                                                                             |
| `e5d52e4eb` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): align pill tabs pressed background                                                                                                    |
| `4db2d9485` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): shrink filetree tab height                                                                                                            |
| `087390803` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): theme color updates                                                                                                                   |
| `1f9be63e9` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): use weak border and base icon color for secondary                                                                                     |
| `6d69ad557` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): update oc-2 secondary button colors                                                                                                   |
| `bcca253de` | ux             | 1/0/0/1=2     | low    | integrated | tweak(ui): hover and active styles for title bar buttons                                                                                         |
| `3690cafeb` | ux             | 1/0/0/1=2     | low    | integrated | tweak(ui): hover and active styles for title bar buttons                                                                                         |
| `4e959849f` | ux             | 1/0/0/1=2     | low    | integrated | tweak(ui): hover and active styles for filetree tabs                                                                                             |
| `09286ccae` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): oc-2 theme updates                                                                                                                    |
| `2f5676106` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): expanded color state on titlebar buttons                                                                                              |
| `db4ff8957` | feature        | 1/0/0/1=2     | low    | integrated | Update oc-2.json                                                                                                                                 |
| `1ed4a9823` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): remove pressed transition for secondary buttons                                                                                       |
| `431f5347a` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): search button style                                                                                                                   |
| `c7a79f187` | feature        | 1/0/0/1=2     | low    | integrated | Update icon-button.css                                                                                                                           |
| `e42cc8511` | feature        | 1/0/0/1=2     | low    | integrated | Update oc-2.json                                                                                                                                 |
| `d730d8be0` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): shrink review diff style toggle                                                                                                       |
| `1571246ba` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): use default cursor for segmented control                                                                                              |
| `1b67339e4` | feature        | 1/0/0/1=2     | low    | integrated | Update radio-group.css                                                                                                                           |
| `06b2304a5` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): override for the radio group in the review                                                                                            |
| `31e964e7c` | feature        | 1/0/0/1=2     | low    | integrated | Update oc-2.json                                                                                                                                 |
| `bb6d1d502` | ux             | 1/0/0/1=2     | low    | integrated | tweak(ui): adjust review diff style hover radius                                                                                                 |
| `47b4de353` | protocol       | 1/0/0/1=2     | low    | integrated | tweak(ui): tighten review header action spacing                                                                                                  |
| `ba919fb61` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): shrink review expand/collapse width                                                                                                   |
| `50923f06f` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): remove pressed scale for secondary buttons                                                                                            |
| `d8a4a125c` | feature        | 1/0/0/1=2     | low    | integrated | Update oc-2.json                                                                                                                                 |
| `7faa8cb11` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): reduce review panel padding                                                                                                           |
| `dec782754` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                                  |
| `c71f4d484` | feature        | 1/0/0/1=2     | low    | integrated | Update oc-2.json                                                                                                                                 |
| `d5971e2da` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/cli/cmd/import.ts from Bun.file() to Filesystem module (#14143)                                                            |
| `898bcdec8` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/cli/cmd/agent.ts from Bun.file()/Bun.write() to Filesystem module (#14142)                                                 |
| `3cde93bf2` | protocol       | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/auth/index.ts from Bun.file()/Bun.write() to Filesystem module (#14140)                                                    |
| `a2469d933` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/acp/agent.ts from Bun.file() to Filesystem module (#14139)                                                                 |
| `e37a9081a` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/cli/cmd/session.ts from Bun.file() to statSync (#14144)                                                                    |
| `a4b36a72a` | feature        | 1/0/0/1=2     | low    | integrated | refactor: migrate src/file/time.ts from Bun.file() to stat (#14141)                                                                              |
| `ec7c72da3` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): restyle reasoning blocks                                                                                                              |
| `2589eb207` | feature        | 1/0/0/1=2     | low    | integrated | tweak(app): shorten prompt mode toggle tooltips                                                                                                  |
| `cfea5c73d` | feature        | 1/0/0/1=2     | low    | integrated | tweak(app): delay prompt mode toggle tooltip                                                                                                     |
| `d366a1430` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/lsp/server.ts from Bun.file()/Bun.write() to Filesystem module (#14138)                                                    |
| `87c16374a` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(lsp): use HashiCorp releases API for installing terraform-ls (#14200)                                                                        |
| `7033b4d0a` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(win32): Sidecar spawning a window (#14197)                                                                                                   |
| `639d1dd8f` | infra          | 1/0/0/1=2     | low    | integrated | chore: add compliance checks for issues and PRs with recheck on edit (#14170)                                                                    |
| `b90967936` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                                  |
| `b75a89776` | feature        | 1/0/0/1=2     | low    | integrated | refactor: migrate src/lsp/client.ts from Bun.file() to Filesystem module (#14137)                                                                |
| `97520c827` | feature        | 0/0/0/-1=-1   | high   | skipped    | refactor: migrate src/provider/models.ts from Bun.file()/Bun.write() to Filesystem module (#14131)                                               |
| `48dfa45a9` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/util/log.ts from Bun.file() to Node.js fs module (#14136)                                                                  |
| `6fb4f2a7a` | ux             | 0/0/0/-1=-1   | high   | skipped    | refactor: migrate src/cli/cmd/tui/thread.ts from Bun.file() to Filesystem module (#14135)                                                        |
| `5d12eb952` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/shell/shell.ts from Bun.file() to statSync (#14134)                                                                        |
| `359360ad8` | feature        | 0/0/0/-1=-1   | high   | skipped    | refactor: migrate src/provider/provider.ts from Bun.file() to Filesystem module (#14132)                                                         |
| `ae398539c` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/session/instruction.ts from Bun.file() to Filesystem module (#14130)                                                       |
| `5fe237a3f` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/skill/discovery.ts from Bun.file()/Bun.write() to Filesystem module (#14133)                                               |
| `088eac9d4` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: opencode run crashing, and show errored tool calls in output (#14206)                                                                       |
| `c16207488` | infra          | 1/0/0/1=2     | low    | integrated | chore: skip PR standards checks for PRs created before Feb 18 2026 6PM EST (#14208)                                                              |
| `57b63ea83` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/session/prompt.ts from Bun.file() to Filesystem/stat modules (#14128)                                                      |
| `a8347c376` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/storage/db.ts from Bun.file() to statSync (#14124)                                                                         |
| `9e6cb8910` | protocol       | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/mcp/auth.ts from Bun.file()/Bun.write() to Filesystem module (#14125)                                                      |
| `819d09e64` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/storage/json-migration.ts from Bun.file() to Filesystem module (#14123)                                                    |
| `a624871cc` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/storage/storage.ts from Bun.file()/Bun.write() to Filesystem module (#14122)                                               |
| `bd52ce564` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate remaining tool files from Bun.file() to Filesystem/stat modules (#14121)                                                       |
| `270b807cd` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/tool/edit.ts from Bun.file() to Filesystem module (#14120)                                                                 |
| `36bc07a5a` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/tool/write.ts from Bun.file() to Filesystem module (#14119)                                                                |
| `14c098941` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/tool/read.ts from Bun.file() to Filesystem module (#14118)                                                                 |
| `ba53c56a2` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): combine diffs in review into one group                                                                                                |
| `9c7629ce6` | feature        | 1/0/0/1=2     | low    | integrated | Update oc-2.json                                                                                                                                 |
| `4a8bdc3c7` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): group edited files list styling                                                                                                       |
| `fd61be407` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): show added diff counts in review                                                                                                      |
| `a30105126` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): tighten review diff file info gap                                                                                                     |
| `40f00ccc1` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): use chevron icons for review diff rows                                                                                                |
| `44049540b` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): add open-file tooltip icon                                                                                                            |
| `3d0f24067` | feature        | 1/0/0/1=2     | low    | integrated | tweak(app): tighten prompt dock padding                                                                                                          |
| `5d8664c13` | feature        | 1/0/0/1=2     | low    | integrated | tweak(app): adjust session turn horizontal padding                                                                                               |
| `6042785c5` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): rtl-truncate edited file paths                                                                                                        |
| `802ccd378` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): rotate collapsible chevron icon                                                                                                       |
| `3a07dd8d9` | feature        | 1/0/0/0=1     | medium | skipped    | refactor: migrate src/project/project.ts from Bun.file() to Filesystem/stat modules (#14126)                                                     |
| `568eccb4c` | ux             | -1/0/0/-1=-2  | high   | skipped    | Revert: all refactor commits migrating from Bun.file() to Filesystem module                                                                      |
| `d62045553` | feature        | 1/0/0/1=2     | low    | integrated | app: deduplicate allServers list                                                                                                                 |
| `11a37834c` | ux             | 0/0/0/-1=-1   | high   | skipped    | tui: ensure onExit callback fires after terminal output is written                                                                               |
| `3a416f6f3` | feature        | 1/0/0/1=2     | low    | integrated | sdk: fix nested exports transformation in publish script                                                                                         |
| `189347314` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: token substitution in OPENCODE_CONFIG_CONTENT (alternate take) (#14047)                                                                     |
| `4b878f6ae` | infra          | 1/0/0/0=1     | medium | skipped    | chore: generate                                                                                                                                  |
| `308e50083` | protocol       | 0/0/0/-1=-1   | high   | skipped    | tweak: bake in the aws and google auth pkgs (#14241)                                                                                             |
| `c7b35342d` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `d07f09925` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(app): terminal rework (#14217)                                                                                                               |
| `885d71636` | feature        | 1/0/0/1=2     | low    | integrated | desktop: fetch defaultServer at top level                                                                                                        |
| `d2d5f3c04` | feature        | 1/0/0/1=2     | low    | integrated | app: fix typecheck                                                                                                                               |
| `38f7071da` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `8ebdbe0ea` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(core): text files missclassified as binary                                                                                                   |
| `338393c01` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): accordion styles                                                                                                                       |
| `0fcba68d4` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `02a949506` | ux             | 0/0/0/-1=-1   | high   | skipped    | Remove use of Bun.file (#14215)                                                                                                                  |
| `08a2d002b` | docs           | -1/-1/-1/1=-2 | low    | skipped    | zen: gemini 3.1 pro                                                                                                                              |
| `6b8902e8b` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): navigate to last session on project nav                                                                                                |
| `56dda4c98` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `3c21735b3` | ux             | 0/0/0/-1=-1   | high   | skipped    | refactor: migrate from Bun.Glob to npm glob package                                                                                              |
| `f2858a42b` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `50883cc1e` | feature        | 1/0/0/1=2     | low    | integrated | app: make localhost urls work in isLocal                                                                                                         |
| `af72010e9` | ux             | -1/0/0/-1=-2  | high   | skipped    | Revert "refactor: migrate from Bun.Glob to npm glob package"                                                                                     |
| `850402f09` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `91f8dd5f5` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `5364ab74a` | feature        | 0/0/0/-1=-1   | high   | skipped    | tweak: add support for medium reasoning w/ gemini 3.1 (#14316)                                                                                   |
| `7e35d0c61` | feature        | 0/0/0/-1=-1   | high   | skipped    | core: bump ai sdk packages for google, google vertex, anthropic, bedrock, and provider utils (#14318)                                            |
| `cb8b74d3f` | ux             | 0/0/0/-1=-1   | high   | skipped    | refactor: migrate from Bun.Glob to npm glob package (#14317)                                                                                     |
| `8b9964879` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                                            |
| `00c079868` | feature        | 1/0/0/1=2     | low    | integrated | test: fix discovery test to boot up server instead of relying on 3rd party (#14327)                                                              |
| `1867f1aca` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                                  |
| `b64d0768b` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs(ko): improve wording in ecosystem, enterprise, formatters, and github docs (#14220)                                                         |
| `190d2957e` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(core): normalize file.status paths relative to instance dir (#14207)                                                                         |
| `3d9f6c0fe` | feature        | 1/0/0/1=2     | low    | integrated | feat(i18n): update Japanese translations to WSL integration (#13160)                                                                             |
| `7fb2081dc` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `7729c6d89` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `40a939f5f` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `f8dad0ae1` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(app): terminal issues (#14329)                                                                                                               |
| `49cc872c4` | infra          | 1/0/0/1=2     | low    | integrated | chore: refactor composer/dock components (#14328)                                                                                                |
| `c76a81434` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `1a1437e78` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(github): action branch detection and 422 handling (#14322)                                                                                   |
| `04cf2b826` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.2.7                                                                                                                                  |
| `dd011e879` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): clear todos on abort                                                                                                                   |
| `7a42ecddd` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `824ab4cec` | ux             | 0/0/0/-1=-1   | high   | skipped    | feat(tui): add custom tool and mcp call responses visible and collapsable (#10649)                                                               |
| `193013a44` | feature        | 0/0/0/-1=-1   | high   | skipped    | feat(opencode): support adaptive thinking for claude sonnet 4.6 (#14283)                                                                         |
| `686dd330a` | infra          | 0/0/0/-1=-1   | high   | skipped    | chore: generate                                                                                                                                  |
| `fca016648` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): black screen on launch with sidecar server                                                                                             |
| `f2090b26c` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.2.8                                                                                                                                  |
| `cb5a0de42` | protocol       | 1/0/0/1=2     | low    | integrated | core: remove User-Agent header assertion from LLM test to fix failing test                                                                       |
| `d32dd4d7f` | docs           | 1/-1/-1/1=0   | low    | skipped    | docs: update providers layout and Windows sidebar label                                                                                          |
| `ae50f24c0` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(web): correct config import path in Korean enterprise docs                                                                                   |
| `01d518708` | feature        | 0/0/0/-1=-1   | high   | skipped    | remove unnecessary deep clones from session loop and LLM stream (#14354)                                                                         |
| `8ad60b1ec` | ux             | 0/0/0/-1=-1   | high   | skipped    | Use structuredClone instead of remeda's clone (#14351)                                                                                           |
| `d2d7a37bc` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: add missing id/sessionID/messageID to MCP tool attachments (#14345)                                                                         |
| `998c8bf3a` | ux             | 1/0/0/1=2     | low    | integrated | tweak(ui): stabilize collapsible chevron hover                                                                                                   |
| `a3181d5fb` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): nudge edited files chevron                                                                                                            |
| `ae98be83b` | protocol       | 1/0/0/1=2     | low    | integrated | fix(desktop): restore settings header mask                                                                                                       |
| `63a469d0c` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): refine session feed spacing                                                                                                           |
| `8b99ac651` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): tone down reasoning emphasis                                                                                                          |
| `8d781b08c` | feature        | 1/0/0/1=2     | low    | integrated | tweak(ui): adjust session feed spacing                                                                                                           |
| `1a329ba47` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix: issue from structuredClone addition by using unwrap (#14359)                                                                                |
| `1eb6caa3c` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.2.9                                                                                                                                  |
| `04a634a80` | feature        | 1/0/0/1=2     | low    | integrated | test: merge test files into a single file (#14366)                                                                                               |
| `d86c10816` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs: clarify tool name collision precedence (#14313)                                                                                            |
| `1c2416b6d` | feature        | 1/0/0/1=2     | low    | integrated | desktop: don't spawn sidecar if default is localhost server                                                                                      |
| `443214871` | feature        | 1/0/0/1=2     | low    | integrated | sdk: build to dist/ instead of dist/src (#14383)                                                                                                 |
| `296250f1b` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.2.10                                                                                                                                 |
| `a04e4e81f` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                                   |
| `93615bef2` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(cli): missing plugin deps cause TUI to black screen (#14432)                                                                                 |
| `7e1051af0` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(ui): show full turn duration in assistant meta (#14378)                                                                                      |
| `ac0b37a7b` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(snapshot): respect info exclude in snapshot staging (#13495)                                                                                 |
| `1de12604c` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(ui): preserve url slashes for root workspace (#14294)                                                                                        |
| `241059302` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(github): support variant in github action and opencode github run (#14431)                                                                   |
| `7e0e35af3` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: update agent                                                                                                                              |
| `4e9ef3ecc` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(app): terminal issues (#14435)                                                                                                               |
| `7e681b0bc` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): large text pasted into prompt-input causes main thread lock                                                                            |
| `7419ebc87` | feature        | 1/0/0/0=1     | medium | skipped    | feat: add list sessions for all sessions (experimental) (#14038)                                                                                 |
| `7867ba441` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                                  |
| `92ab4217c` | feature        | 1/0/0/1=2     | low    | integrated | desktop: bring back -i in sidecar arguments                                                                                                      |

## Execution Queue

1. [ ] Confirm high-risk items (ported vs skipped).
2. [ ] Integrate low/medium-risk high-value items.
3. [ ] Update ledger with final status mapping.

## Mapping to Ledger

| Upstream Commit | Status     | Local Commit | Note                                                                                                                                             |
| :-------------- | :--------- | :----------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| `81b5a6a08`     | integrated | -            | fix(app):workspace reset (#13170)                                                                                                                |
| `8f56ed5b8`     | integrated | -            | chore: generate                                                                                                                                  |
| `fbabce112`     | integrated | -            | fix(app): translations                                                                                                                           |
| `6b30e0b75`     | skipped    | -            | chore: update docs sync workflow                                                                                                                 |
| `e3471526f`     | integrated | -            | add square logo variants to brand page                                                                                                           |
| `6b4d617df`     | skipped    | -            | feat: adjust read tool so that it can handle dirs too (#13090)                                                                                   |
| `006d673ed`     | skipped    | -            | tweak: make read tool offset 1 indexed instead of 0 to avoid confusion that could be caused by line #s being 1 based (#13198)                    |
| `e2a33f75e`     | integrated | -            | Update VOUCHED list                                                                                                                              |
| `8c7b35ad0`     | skipped    | -            | tweak: compaction check (#13214)                                                                                                                 |
| `125727d09`     | integrated | -            | upgrade opentui to 0.1.79 (#13036)                                                                                                               |
| `264dd213f`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `c856f875a`     | integrated | -            | chore: upgrade bun to 1.3.9 (#13223)                                                                                                             |
| `8577eb8ec`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `3befd0c6c`     | skipped    | -            | tweak: use promise all for mcp listTools calls (#13229)                                                                                          |
| `8eea53a41`     | skipped    | -            | docs(ar): second-pass localization cleanup                                                                                                       |
| `aea68c386`     | skipped    | -            | fix(docs): locale translations for nav elements and headings                                                                                     |
| `81ca2df6a`     | integrated | -            | fix(app): guard randomUUID in insecure browser contexts (#13237)                                                                                 |
| `bf5a01edd`     | skipped    | -            | feat(opencode): Venice Add automatic variant generation for Venice models (#12106)                                                               |
| `135f8ffb2`     | skipped    | -            | feat(tui): add toggle to hide session header (#13244)                                                                                            |
| `5bdf1c4b9`     | integrated | -            | Update VOUCHED list                                                                                                                              |
| `ad2087094`     | skipped    | -            | support custom api url per model                                                                                                                 |
| `66780195d`     | integrated | -            | chore: generate                                                                                                                                  |
| `e269788a8`     | skipped    | -            | feat: support claude agent SDK-style structured outputs in the OpenCode SDK (#8161)                                                              |
| `f6e7aefa7`     | integrated | -            | chore: generate                                                                                                                                  |
| `8f9742d98`     | skipped    | -            | fix(win32): use ffi to get around bun raw input/ctrl+c issues (#13052)                                                                           |
| `03de51bd3`     | integrated | -            | release: v1.1.60                                                                                                                                 |
| `d86f24b6b`     | integrated | -            | zen: return cost                                                                                                                                 |
| `624dd94b5`     | skipped    | -            | tweak: tool outputs to be more llm friendly (#13269)                                                                                             |
| `1413d77b1`     | integrated | -            | desktop: sqlite migration progress bar (#13294)                                                                                                  |
| `0eaeb4588`     | integrated | -            | Testing SignPath Integration (#13308)                                                                                                            |
| `fa97475ee`     | integrated | -            | ci: move test-sigining policy                                                                                                                    |
| `5f421883a`     | integrated | -            | chore: style loading screen                                                                                                                      |
| `ecb274273`     | integrated | -            | wip(ui): diff virtualization (#12693)                                                                                                            |
| `9f9f0fb8e`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `d72314708`     | integrated | -            | feat: update to not post comment on workflows when no duplicates found (#13238)                                                                  |
| `d82d22b2d`     | integrated | -            | wip: zen                                                                                                                                         |
| `a11556505`     | skipped    | -            | core: allow model configurations without npm/api provider details                                                                                |
| `892bb7526`     | integrated | -            | release: v1.1.61                                                                                                                                 |
| `85df10671`     | integrated | -            | chore: generate                                                                                                                                  |
| `ae811ad8d`     | integrated | -            | wip: zen                                                                                                                                         |
| `56ad2db02`     | skipped    | -            | core: expose tool arguments in shell hook for plugin visibility                                                                                  |
| `ff4414bb1`     | integrated | -            | chore: refactor packages/app files (#13236)                                                                                                      |
| `ed472d8a6`     | integrated | -            | fix(app): more defensive session context metrics                                                                                                 |
| `a82ca8600`     | integrated | -            | fix(app): more defensive code component                                                                                                          |
| `658bf6fa5`     | skipped    | -            | zen: minimax m2.5                                                                                                                                |
| `59a323e9a`     | skipped    | -            | wip: zen                                                                                                                                         |
| `ecab692ca`     | skipped    | -            | fix(docs): correct `format` attribute in `StructuredOutputs` (#13340)                                                                            |
| `2db618dea`     | integrated | -            | fix: downgrade bun to 1.3.5 (#13347)                                                                                                             |
| `847e06f9e`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `ba54cee55`     | skipped    | -            | feat(tool): return image attachments from webfetch (#13331)                                                                                      |
| `789705ea9`     | skipped    | -            | ignore: document test fixtures for agents                                                                                                        |
| `da952135c`     | integrated | -            | chore(app): refactor for better solidjs hygiene (#13344)                                                                                         |
| `0771e3a8b`     | integrated | -            | fix(app): preserve undo history for plain-text paste (#13351)                                                                                    |
| `ff0abacf4`     | integrated | -            | fix(app): project icons unloading                                                                                                                |
| `aaee5fb68`     | integrated | -            | release: v1.1.62                                                                                                                                 |
| `e6e9c15d3`     | skipped    | -            | improve codex model list                                                                                                                         |
| `ac018e3a3`     | integrated | -            | release: v1.1.63                                                                                                                                 |
| `d1ee4c8dc`     | integrated | -            | test: add more test cases for project.test.ts (#13355)                                                                                           |
| `958320f9c`     | integrated | -            | fix(app): remote http server connections                                                                                                         |
| `50f208d69`     | integrated | -            | fix(app): suggestion active state broken                                                                                                         |
| `3696d1ded`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `81c623f26`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `e9b9a62fe`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `7ccf223c8`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `70303d0b4`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `ff3b174c4`     | integrated | -            | fix(app): normalize oauth error messages                                                                                                         |
| `4e0f509e7`     | integrated | -            | feat(app): option to turn off sound effects                                                                                                      |
| `548608b7a`     | integrated | -            | fix(app): terminal pty isolation                                                                                                                 |
| `11dd281c9`     | skipped    | -            | docs: update STACKIT provider documentation with typo fix (#13357)                                                                               |
| `20dcff1e2`     | skipped    | -            | chore: generate                                                                                                                                  |
| `c0814da78`     | skipped    | -            | do not open console on error (#13374)                                                                                                            |
| `a8f288452`     | skipped    | -            | feat: windows selection behavior, manual ctrl+c (#13315)                                                                                         |
| `4018c863e`     | integrated | -            | fix: baseline CPU detection (#13371)                                                                                                             |
| `445e0d767`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `93eee0daf`     | ported     | -            | fix: look for recent model in fallback in cli (#12582)                                                                                           |
| `d475fd613`     | skipped    | -            | chore: generate                                                                                                                                  |
| `f66624fe6`     | skipped    | -            | chore: cleanup flag code (#13389)                                                                                                                |
| `29671c139`     | integrated | -            | fix: token substitution in OPENCODE_CONFIG_CONTENT (#13384)                                                                                      |
| `76db21867`     | integrated | -            | release: v1.1.64                                                                                                                                 |
| `991496a75`     | integrated | -            | fix: resolve ACP hanging indefinitely in thinking state on Windows (#13222)                                                                      |
| `adb0c4d4f`     | integrated | -            | desktop: only show loading window if sqlite migration is necessary                                                                               |
| `0303c29e3`     | integrated | -            | fix(app): failed to create store                                                                                                                 |
| `8da5fd0a6`     | integrated | -            | fix(app): worktree delete                                                                                                                        |
| `b525c03d2`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `7f95cc64c`     | integrated | -            | fix(app): prompt input quirks                                                                                                                    |
| `c9719dff7`     | integrated | -            | fix(app): notification should navigate to session                                                                                                |
| `dec304a27`     | integrated | -            | fix(app): emoji as avatar                                                                                                                        |
| `e0f1c3c20`     | integrated | -            | cleanup desktop loading page                                                                                                                     |
| `fb7b2f6b4`     | integrated | -            | feat(app): toggle all provider models                                                                                                            |
| `dd296f703`     | integrated | -            | fix(app): reconnect event stream on disconnect                                                                                                   |
| `b06afd657`     | integrated | -            | ci: remove signpath policy                                                                                                                       |
| `1608565c8`     | skipped    | -            | feat(hook): add tool.definition hook for plugins to modify tool description and parameters (#4956)                                               |
| `98aeb60a7`     | integrated | -            | fix: ensure @-ing a dir uses the read tool instead of dead list tool (#13428)                                                                    |
| `1fb6c0b5b`     | skipped    | -            | Revert "fix: token substitution in OPENCODE_CONFIG_CONTENT" (#13429)                                                                             |
| `34ebe814d`     | integrated | -            | release: v1.1.65                                                                                                                                 |
| `0d90a22f9`     | skipped    | -            | feat: update some ai sdk packages and uuse adaptive reasoning for opus 4.6 on vertex/bedrock/anthropic (#13439)                                  |
| `693127d38`     | skipped    | -            | feat(cli): add --dir option to run command (#12443)                                                                                              |
| `b8ee88212`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `ebb907d64`     | integrated | -            | fix(desktop): performance optimization for showing large diff & files (#13460)                                                                   |
| `9f20e0d14`     | skipped    | -            | fix(web): sync docs locale cookie on alias redirects (#13109)                                                                                    |
| `ebe5a2b74`     | integrated | -            | fix(app): remount SDK/sync tree when server URL changes (#13437)                                                                                 |
| `b1764b2ff`     | skipped    | -            | docs: Fix zh-cn translation mistake in tools.mdx (#13407)                                                                                        |
| `f991a6c0b`     | skipped    | -            | chore: generate                                                                                                                                  |
| `e242fe19e`     | integrated | -            | fix(web): use prompt_async endpoint to avoid timeout over VPN/tunnel (#12749)                                                                    |
| `1c71604e0`     | integrated | -            | fix(app): terminal resize                                                                                                                        |
| `4f51c0912`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `b8848cfae`     | skipped    | -            | docs(ko): polish Korean phrasing in acp, agents, config, and custom-tools docs (#13446)                                                          |
| `88e2eb541`     | skipped    | -            | docs: add pacman installation option for Arch Linux alongside AUR (#13293)                                                                       |
| `bc1fd0633`     | integrated | -            | fix(test): move timeout config to CLI flag (#13494)                                                                                              |
| `72c09e1dc`     | skipped    | -            | fix: standardize zh-CN docs character set and terminology (#13500)                                                                               |
| `d30e91738`     | integrated | -            | fix(ui): support cmd-click links in inline code (#12552)                                                                                         |
| `d01890388`     | integrated | -            | fix: prevent opencode run crash on malformed tool inputs (#13051)                                                                                |
| `6d95f0d14`     | skipped    | -            | sqlite again (#10597)                                                                                                                            |
| `afb04ed5d`     | integrated | -            | chore: generate                                                                                                                                  |
| `7d4687277`     | integrated | -            | desktop: remote OPENCODE_SQLITE env (#13545)                                                                                                     |
| `d0dcffefa`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `0b9e929f6`     | integrated | -            | desktop: fix rust                                                                                                                                |
| `ffc000de8`     | integrated | -            | release: v1.2.0                                                                                                                                  |
| `1e25df21a`     | integrated | -            | zen: minimax m2.5 & glm5                                                                                                                         |
| `179c40749`     | integrated | -            | fix: tweak websearch tool description date info to avoid cache busts (#13559)                                                                    |
| `b02075844`     | skipped    | -            | tui: show all project sessions from any working directory                                                                                        |
| `cd775a286`     | integrated | -            | release: v1.2.1                                                                                                                                  |
| `ed439b205`     | integrated | -            | ci: test-signing signpath policy                                                                                                                 |
| `df3203d2d`     | integrated | -            | ci: move signpath policy                                                                                                                         |
| `ef205c366`     | integrated | -            | bump vertex ai packages (#13625)                                                                                                                 |
| `759ec104b`     | ported     | -            | fix vercel gateway variants (#13541)                                                                                                             |
| `306fc7707`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `68bb8ce1d`     | skipped    | -            | core: filter sessions at database level to improve session list loading performance                                                              |
| `8631d6c01`     | integrated | -            | core: add comprehensive test coverage for Session.list() filters                                                                                 |
| `3b6b3e6fc`     | integrated | -            | release: v1.2.2                                                                                                                                  |
| `933a491ad`     | ported     | -            | fix: ensure vercel variants pass amazon models under bedrock key (#13631)                                                                        |
| `575f2cf2a`     | integrated | -            | chore: bump nixpkgs to get bun 1.3.9 (#13302)                                                                                                    |
| `67c985ce8`     | integrated | -            | fix: add WAL checkpoint on database open (#13633)                                                                                                |
| `839c5cda1`     | ported     | -            | fix: ensure anthropic models on OR also have variant support (#13498)                                                                            |
| `7911cb62a`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `c190f5f61`     | integrated | -            | release: v1.2.3                                                                                                                                  |
| `460a87f35`     | integrated | -            | fix(app): stack overflow in filetree (#13667)                                                                                                    |
| `85b5f5b70`     | integrated | -            | feat(app): clear notifications action (#13668)                                                                                                   |
| `2bab5e8c3`     | integrated | -            | fix: derive all IDs from file paths during json migration                                                                                        |
| `b5c8bd342`     | integrated | -            | test: add tests for path-derived IDs in json migration                                                                                           |
| `45f005037`     | skipped    | -            | core: add db command for database inspection and querying                                                                                        |
| `d1482e148`     | integrated | -            | release: v1.2.4                                                                                                                                  |
| `eb553f53a`     | integrated | -            | fix: ensure sqlite migration logs to stderr instead of stdout (#13691)                                                                           |
| `985c2a3d1`     | integrated | -            | feat: Add GeistMono Nerd Font to available mono font options (#13720)                                                                            |
| `3aaa34be1`     | integrated | -            | fix(desktop): focus window after update/relaunch (#13701)                                                                                        |
| `376112172`     | skipped    | -            | docs: add Ukrainian README translation (#13697)                                                                                                  |
| `878ddc6a0`     | integrated | -            | fix(app): keybind [shift+tab] (#13695)                                                                                                           |
| `3c85cf4fa`     | integrated | -            | fix(app): only navigate prompt history at input boundaries (#13690)                                                                              |
| `cf50a289d`     | integrated | -            | fix(desktop): issue viewing new files opened from the file tree (#13689)                                                                         |
| `3a3aa300b`     | integrated | -            | feat(app): localize "free usage exceeded" error & "Add credits" clickable link (#13652)                                                          |
| `62a24c2dd`     | integrated | -            | release: v1.2.5                                                                                                                                  |
| `9b23130ac`     | skipped    | -            | feat(opencode): add `cljfmt` formatter support for Clojure files (#13426)                                                                        |
| `d9363da9e`     | skipped    | -            | fix(website): correct zh-CN translation of proprietary terms in zen.mdx (#13734)                                                                 |
| `21e077800`     | skipped    | -            | chore: generate                                                                                                                                  |
| `920255e8c`     | integrated | -            | desktop: use process-wrap instead of manual job object (#13431)                                                                                  |
| `afd0716cb`     | skipped    | -            | feat(opencode): Add Venice support in temperature, topP, topK and smallOption (#13553)                                                           |
| `60807846a`     | integrated | -            | fix(desktop): normalize Linux Wayland/X11 backend and decoration policy (#13143)                                                                 |
| `f7708efa5`     | skipped    | -            | feat: add openai-compatible endpoint support for google-vertex provider (#10303)                                                                 |
| `089ab9def`     | integrated | -            | chore: generate                                                                                                                                  |
| `1d041c886`     | ported     | -            | fix: google vertex var priority (#13816)                                                                                                         |
| `3ebf27aab`     | skipped    | -            | fix(docs): correct critical translation errors in Russian zen page (#13830)                                                                      |
| `45fa5e719`     | integrated | -            | fix(core): remove unnecessary per-message title LLM calls (#13804)                                                                               |
| `b055f973d`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `bb30e0685`     | skipped    | -            | fix (tui): Inaccurate tips (#13845)                                                                                                              |
| `ef979ccfa`     | integrated | -            | fix: bump GitLab provider and auth plugin for mid-session token refresh (#13850)                                                                 |
| `8c1af9b44`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `5cc1d6097`     | skipped    | -            | feat(cli): add --continue and --fork flags to attach command (#13879)                                                                            |
| `fdad823ed`     | skipped    | -            | feat(cli): add db migrate command for JSON to SQLite migration (#13874)                                                                          |
| `ae6e85b2a`     | integrated | -            | ignore: rm random comment on opencode.jsonc                                                                                                      |
| `16332a858`     | skipped    | -            | fix(tui): make use of server dir path for file references in prompts (#13781)                                                                    |
| `160ba295a`     | skipped    | -            | feat(opencode): add `dfmt` formatter support for D language files (#13867)                                                                       |
| `d8c25bfeb`     | integrated | -            | release: v1.2.6                                                                                                                                  |
| `b0afdf6ea`     | skipped    | -            | feat(cli): add session delete command (#13571)                                                                                                   |
| `86e545a23`     | integrated | -            | fix(opencode): ACP sessions never get LLM-generated titles (#13095)                                                                              |
| `9d3c81a68`     | skipped    | -            | feat(acp): add opt-in flag for question tool (#13562)                                                                                            |
| `a580fb47d`     | skipped    | -            | tweak: drop ids from attachments in tools, assign them in prompt.ts instead (#13890)                                                             |
| `d93cefd47`     | integrated | -            | fix(website): fix site in safari 18 (#13894)                                                                                                     |
| `916361198`     | integrated | -            | ci: fixed apt cache not working in publish.yml (#13897)                                                                                          |
| `0e669b601`     | integrated | -            | ci: use `useblacksmith/stickydisk` on linux runners only (#13909)                                                                                |
| `e35a4131d`     | skipped    | -            | core: keep message part order stable when files resolve asynchronously (#13915)                                                                  |
| `422609722`     | integrated | -            | ci: fixed Rust cache for 'cargo install' in publish.yml (#13907)                                                                                 |
| `ea2d089db`     | integrated | -            | ci: fixed missing if condition (#13934)                                                                                                          |
| `d338bd528`     | integrated | -            | Hide server CLI on windows (#13936)                                                                                                              |
| `ace63b3dd`     | skipped    | -            | zen: glm 5 free                                                                                                                                  |
| `a93a1b93e`     | integrated | -            | wip: zen                                                                                                                                         |
| `ed4e4843c`     | integrated | -            | ci: update triage workflow (#13944)                                                                                                              |
| `0186a8506`     | integrated | -            | fix(app): keep Escape handling local to prompt input on macOS desktop (#13963)                                                                   |
| `8d0a303af`     | skipped    | -            | docs(ko): improve Korean translation accuracy and clarity in Zen docs (#13951)                                                                   |
| `4fd3141ab`     | skipped    | -            | docs: improve zh-cn and zh-tw documentation translations (#13942)                                                                                |
| `6e984378d`     | skipped    | -            | fix(docs): correct reversed meaning in Korean plugins logging section (#13945)                                                                   |
| `4eed55973`     | skipped    | -            | chore: generate                                                                                                                                  |
| `07947bab7`     | skipped    | -            | tweak(tui): new session banner with logo and details (#13970)                                                                                    |
| `3dfbb7059`     | integrated | -            | fix(app): recover state after sse reconnect and harden sse streams (#13973)                                                                      |
| `10985671a`     | integrated | -            | feat(app): session timeline/turn rework (#13196)                                                                                                 |
| `277c68d8e`     | integrated | -            | chore: app polish (#13976)                                                                                                                       |
| `e273a31e7`     | integrated | -            | tweak(ui): icon button spacing                                                                                                                   |
| `703d63474`     | integrated | -            | chore: generate                                                                                                                                  |
| `9b1d7047d`     | integrated | -            | tweak(app): keep file tree toggle visible                                                                                                        |
| `0cb11c241`     | integrated | -            | tweak(app): reduce titlebar right padding                                                                                                        |
| `d31e9cff6`     | integrated | -            | tweak(app): use weak borders in titlebar actions                                                                                                 |
| `a8669aba8`     | integrated | -            | tweak(app): match titlebar active bg to hover                                                                                                    |
| `8fcfbd697`     | integrated | -            | tweak(app): align titlebar search text size                                                                                                      |
| `ce0844273`     | integrated | -            | tweak(ui): center titlebar search and soften keybind                                                                                             |
| `98f3ff627`     | integrated | -            | tweak(app): refine titlebar search and open padding                                                                                              |
| `8e243c650`     | integrated | -            | tweak(app): tighten titlebar action padding                                                                                                      |
| `222b6cda9`     | integrated | -            | tweak(ui): update magnifying-glass icon                                                                                                          |
| `4d5e86d8a`     | integrated | -            | feat(desktop): more e2e tests (#13975)                                                                                                           |
| `7ed449974`     | integrated | -            | chore: generate                                                                                                                                  |
| `5a3e0ef13`     | integrated | -            | tweak(ui): show user message meta on hover                                                                                                       |
| `2cac84882`     | integrated | -            | tweak(ui): use provider catalog names                                                                                                            |
| `14684d8e7`     | integrated | -            | tweak(ui): refine user message hover meta                                                                                                        |
| `57a5d5fd3`     | integrated | -            | tweak(ui): show assistant response meta on hover                                                                                                 |
| `1d78100f6`     | integrated | -            | tweak(ui): allow full-width user message meta                                                                                                    |
| `652a77655`     | integrated | -            | ui: add clearer 'Copy response' tooltip label for text parts                                                                                     |
| `adfbfe350`     | integrated | -            | tui: increase prompt mode toggle height for better clickability                                                                                  |
| `d055c1cad`     | integrated | -            | fix(desktop): avoid sidecar health-check timeout on shell startup (#13925)                                                                       |
| `46739ca7c`     | integrated | -            | fix(app): ui flashing when switching tabs (#13978)                                                                                               |
| `df59d1412`     | integrated | -            | fix: Homepage video section layout shift (#13987)                                                                                                |
| `47435f6e1`     | ported     | -            | fix: don't fetch models.dev on completion (#13997)                                                                                               |
| `ea96f898c`     | integrated | -            | ci: rm remap for jlongster since he is in org now (#14000)                                                                                       |
| `b784c923a`     | skipped    | -            | tweak(ui): bump button heights and align permission prompt layout                                                                                |
| `2c17a980f`     | integrated | -            | refactor(ui): extract dock prompt shell                                                                                                          |
| `bd3d1413f`     | integrated | -            | tui: add warning icon to permission requests for better visibility                                                                               |
| `26f835cdd`     | integrated | -            | tweak(ui): icon-interactive-base color change dark mode                                                                                          |
| `a69b339ba`     | integrated | -            | fix(ui): use icon-strong-base for active titlebar icon buttons                                                                                   |
| `0bc1dcbe1`     | integrated | -            | tweak(ui): update icon transparency                                                                                                              |
| `ce7484b4f`     | integrated | -            | tui: fix share button text styling to use consistent 12px regular font weight                                                                    |
| `a685e7a80`     | integrated | -            | tui: show monochrome file icons by default in tree view, revealing colors on hover to reduce visual clutter and help users focus on code content |
| `737990356`     | integrated | -            | tui: improve modified file visibility and button spacing                                                                                         |
| `4025b655a`     | integrated | -            | desktop: replicate tauri-plugin-shell logic (#13986)                                                                                             |
| `fb79dd7bf`     | skipped    | -            | fix: Invalidate oauth credentials when oauth provider says so (#14007)                                                                           |
| `20f43372f`     | integrated | -            | fix(app): terminal disconnect and resync (#14004)                                                                                                |
| `3a505b269`     | integrated | -            | fix(app): virtualizer getting wrong scroll root                                                                                                  |
| `7a66ec6bc`     | skipped    | -            | zen: sonnet 4.6                                                                                                                                  |
| `bab3124e8`     | integrated | -            | fix(app): prompt input quirks                                                                                                                    |
| `92912219d`     | integrated | -            | tui: simplify prompt mode toggle icon colors via CSS and tighten message timeline padding                                                        |
| `4ccb82e81`     | skipped    | -            | feat: surface plugin auth providers in the login picker (#13921)                                                                                 |
| `2a2437bf2`     | skipped    | -            | chore: generate                                                                                                                                  |
| `c1b03b728`     | integrated | -            | fix: make read tool more mem efficient (#14009)                                                                                                  |
| `d327a2b1c`     | integrated | -            | chore(app): use radio group in prompt input (#14025)                                                                                             |
| `26c7b240b`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `e345b89ce`     | integrated | -            | fix(app): better tool call batching                                                                                                              |
| `cb88fe26a`     | skipped    | -            | chore: add missing newline (#13992)                                                                                                              |
| `3b9758062`     | skipped    | -            | tweak: ensure read tool uses fs/promises for all paths (#14027)                                                                                  |
| `bad394cd4`     | integrated | -            | chore: remove leftover patch (#13749)                                                                                                            |
| `5512231ca`     | skipped    | -            | fix(tui): style scrollbox for permission and sidebar (#12752)                                                                                    |
| `ad3c19283`     | skipped    | -            | tui: exit cleanly without hanging after session ends                                                                                             |
| `bca793d06`     | skipped    | -            | ci: ensure triage adds acp label (#14039)                                                                                                        |
| `a344a766f`     | skipped    | -            | chore: generate                                                                                                                                  |
| `c56f4aa5d`     | skipped    | -            | refactor: simplify redundant ternary in updateMessage (#13954)                                                                                   |
| `ad92181fa`     | skipped    | -            | feat: add Kilo as a native provider (#13765)                                                                                                     |
| `572a037e5`     | integrated | -            | chore: generate                                                                                                                                  |
| `0ca75544a`     | ported     | -            | fix: dont autoload kilo (#14052)                                                                                                                 |
| `25f3eef95`     | integrated | -            | fix: ensure explore subagent has external_directory perm set to ask instead of auto denying (#14060)                                             |
| `1109a282e`     | integrated | -            | ci: add nix-eval workflow for cross-platform flake evaluation (#12175)                                                                           |
| `e96f6385c`     | integrated | -            | fix(opencode): fix Clojure syntax highlighting (#13453)                                                                                          |
| `6eb043aed`     | integrated | -            | ci: allow commits on top of beta PRs (#11924)                                                                                                    |
| `5aeb30534`     | integrated | -            | desktop: temporarily disable wsl                                                                                                                 |
| `6cd3a5902`     | integrated | -            | desktop: cleanup                                                                                                                                 |
| `3394402ae`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `cc86a64bb`     | integrated | -            | tui: simplify mode toggle icon styling                                                                                                           |
| `c34ad7223`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `fbe9669c5`     | integrated | -            | fix: use group-hover for file tree icon color swap at all nesting levels                                                                         |
| `e132dd2c7`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `e4b548fa7`     | skipped    | -            | docs: add policy about AI-generated security reports                                                                                             |
| `00c238777`     | integrated | -            | chore: cleanup (#14113)                                                                                                                          |
| `2611c35ac`     | integrated | -            | fix(app): lower threshold for diff hiding                                                                                                        |
| `1bb857417`     | integrated | -            | app: refactor server management backend (#13813)                                                                                                 |
| `6b29896a3`     | skipped    | -            | feat: Add centralized filesystem module for Bun.file migration (#14117)                                                                          |
| `3aaf29b69`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `4a5823562`     | integrated | -            | desktop: fix isLocal                                                                                                                             |
| `f8904e397`     | integrated | -            | desktop: handle sidecar key in projectsKey                                                                                                       |
| `d27dbfe06`     | integrated | -            | fix(cli): session list --max-count not honored, shows too few sessions (#14162)                                                                  |
| `83b7d8e04`     | integrated | -            | feat: GitLab Duo - bump gitlab-ai-provider to 3.6.0 (adds Sonnet 4.6) (#14115)                                                                   |
| `fc1addb8f`     | skipped    | -            | ignore: tweak contributing md (#14168)                                                                                                           |
| `38572b817`     | skipped    | -            | feat: add Julia language server support (#14129)                                                                                                 |
| `37b24f487`     | skipped    | -            | refactor: migrate index.ts from Bun.file() to Filesystem module (#14160)                                                                         |
| `91a3ee642`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `3d189b42a`     | skipped    | -            | refactor: migrate file/ripgrep.ts from Bun.file()/Bun.write() to Filesystem module (#14159)                                                      |
| `a5c15a23e`     | skipped    | -            | core: allow readJson to be called without explicit type parameter                                                                                |
| `472d01fba`     | skipped    | -            | refactor: migrate cli/cmd/run.ts from Bun.file() to Filesystem/stat modules (#14155)                                                             |
| `b714bb21d`     | integrated | -            | ci: switch to standard GitHub cache action for Bun dependencies                                                                                  |
| `a500eaa2d`     | skipped    | -            | refactor: migrate format/formatter.ts from Bun.file() to Filesystem module (#14153)                                                              |
| `82a323ef7`     | integrated | -            | refactor: migrate cli/cmd/github.ts from Bun.write() to Filesystem module (#14154)                                                               |
| `ef155f376`     | skipped    | -            | refactor: migrate file/index.ts from Bun.file() to Filesystem module (#14152)                                                                    |
| `8f4a72c57`     | skipped    | -            | refactor: migrate config/markdown.ts from Bun.file() to Filesystem module (#14151)                                                               |
| `e0e8b9438`     | integrated | -            | refactor: migrate uninstall.ts from Bun.file()/Bun.write() to Filesystem module (#14150)                                                         |
| `c88ff3c08`     | skipped    | -            | refactor: migrate src/bun/index.ts from Bun.file()/Bun.write() to Filesystem module (#14147)                                                     |
| `eb3f33769`     | skipped    | -            | refactor: migrate clipboard.ts from Bun.file() to Filesystem module (#14148)                                                                     |
| `5638b782c`     | skipped    | -            | refactor: migrate editor.ts from Bun.file()/Bun.write() to Filesystem module (#14149)                                                            |
| `d447b7694`     | integrated | -            | fix(github): emit PROMPT_TOO_LARGE error on context overflow (#14166)                                                                            |
| `3f60a6c2a`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `ef14f64f9`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `8408e4702`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `72c12d59a`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `be2e6f192`     | skipped    | -            | fix(opencode): update pasteImage to only increment count when the previous attachment is an image too (#14173)                                   |
| `8bf06cbcc`     | skipped    | -            | refactor: migrate src/global/index.ts from Bun.file() to Filesystem module (#14146)                                                              |
| `24a984132`     | integrated | -            | zen: update sst version                                                                                                                          |
| `c6bd32000`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `42aa28d51`     | integrated | -            | chore: cleanup (#14181)                                                                                                                          |
| `1133d87be`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `de25703e9`     | integrated | -            | fix(app): terminal cross-talk (#14184)                                                                                                           |
| `1aa18c6cd`     | skipped    | -            | feat(plugin): pass sessionID and callID to shell.env hook input (#13662)                                                                         |
| `2d7c9c969`     | skipped    | -            | chore: generate                                                                                                                                  |
| `d6331cf79`     | integrated | -            | Update colors.css                                                                                                                                |
| `12016c8eb`     | integrated | -            | oc-2 theme init                                                                                                                                  |
| `5d69f0028`     | integrated | -            | button style tweaks                                                                                                                              |
| `24ce49d9d`     | integrated | -            | fix(ui): add previous smoke colors                                                                                                               |
| `0888c0237`     | integrated | -            | tweak(ui): file tree background color                                                                                                            |
| `9110e6a2a`     | integrated | -            | tweak(ui): share button border                                                                                                                   |
| `f20c0bffd`     | integrated | -            | tweak(ui): unify titlebar expanded button background                                                                                             |
| `e5d52e4eb`     | integrated | -            | tweak(ui): align pill tabs pressed background                                                                                                    |
| `4db2d9485`     | integrated | -            | tweak(ui): shrink filetree tab height                                                                                                            |
| `087390803`     | integrated | -            | tweak(ui): theme color updates                                                                                                                   |
| `1f9be63e9`     | integrated | -            | tweak(ui): use weak border and base icon color for secondary                                                                                     |
| `6d69ad557`     | integrated | -            | tweak(ui): update oc-2 secondary button colors                                                                                                   |
| `bcca253de`     | integrated | -            | tweak(ui): hover and active styles for title bar buttons                                                                                         |
| `3690cafeb`     | integrated | -            | tweak(ui): hover and active styles for title bar buttons                                                                                         |
| `4e959849f`     | integrated | -            | tweak(ui): hover and active styles for filetree tabs                                                                                             |
| `09286ccae`     | integrated | -            | tweak(ui): oc-2 theme updates                                                                                                                    |
| `2f5676106`     | integrated | -            | tweak(ui): expanded color state on titlebar buttons                                                                                              |
| `db4ff8957`     | integrated | -            | Update oc-2.json                                                                                                                                 |
| `1ed4a9823`     | integrated | -            | tweak(ui): remove pressed transition for secondary buttons                                                                                       |
| `431f5347a`     | integrated | -            | tweak(ui): search button style                                                                                                                   |
| `c7a79f187`     | integrated | -            | Update icon-button.css                                                                                                                           |
| `e42cc8511`     | integrated | -            | Update oc-2.json                                                                                                                                 |
| `d730d8be0`     | integrated | -            | tweak(ui): shrink review diff style toggle                                                                                                       |
| `1571246ba`     | integrated | -            | tweak(ui): use default cursor for segmented control                                                                                              |
| `1b67339e4`     | integrated | -            | Update radio-group.css                                                                                                                           |
| `06b2304a5`     | integrated | -            | tweak(ui): override for the radio group in the review                                                                                            |
| `31e964e7c`     | integrated | -            | Update oc-2.json                                                                                                                                 |
| `bb6d1d502`     | integrated | -            | tweak(ui): adjust review diff style hover radius                                                                                                 |
| `47b4de353`     | integrated | -            | tweak(ui): tighten review header action spacing                                                                                                  |
| `ba919fb61`     | integrated | -            | tweak(ui): shrink review expand/collapse width                                                                                                   |
| `50923f06f`     | integrated | -            | tweak(ui): remove pressed scale for secondary buttons                                                                                            |
| `d8a4a125c`     | integrated | -            | Update oc-2.json                                                                                                                                 |
| `7faa8cb11`     | integrated | -            | tweak(ui): reduce review panel padding                                                                                                           |
| `dec782754`     | integrated | -            | chore: generate                                                                                                                                  |
| `c71f4d484`     | integrated | -            | Update oc-2.json                                                                                                                                 |
| `d5971e2da`     | skipped    | -            | refactor: migrate src/cli/cmd/import.ts from Bun.file() to Filesystem module (#14143)                                                            |
| `898bcdec8`     | skipped    | -            | refactor: migrate src/cli/cmd/agent.ts from Bun.file()/Bun.write() to Filesystem module (#14142)                                                 |
| `3cde93bf2`     | skipped    | -            | refactor: migrate src/auth/index.ts from Bun.file()/Bun.write() to Filesystem module (#14140)                                                    |
| `a2469d933`     | skipped    | -            | refactor: migrate src/acp/agent.ts from Bun.file() to Filesystem module (#14139)                                                                 |
| `e37a9081a`     | skipped    | -            | refactor: migrate src/cli/cmd/session.ts from Bun.file() to statSync (#14144)                                                                    |
| `a4b36a72a`     | integrated | -            | refactor: migrate src/file/time.ts from Bun.file() to stat (#14141)                                                                              |
| `ec7c72da3`     | integrated | -            | tweak(ui): restyle reasoning blocks                                                                                                              |
| `2589eb207`     | integrated | -            | tweak(app): shorten prompt mode toggle tooltips                                                                                                  |
| `cfea5c73d`     | integrated | -            | tweak(app): delay prompt mode toggle tooltip                                                                                                     |
| `d366a1430`     | skipped    | -            | refactor: migrate src/lsp/server.ts from Bun.file()/Bun.write() to Filesystem module (#14138)                                                    |
| `87c16374a`     | integrated | -            | fix(lsp): use HashiCorp releases API for installing terraform-ls (#14200)                                                                        |
| `7033b4d0a`     | integrated | -            | fix(win32): Sidecar spawning a window (#14197)                                                                                                   |
| `639d1dd8f`     | integrated | -            | chore: add compliance checks for issues and PRs with recheck on edit (#14170)                                                                    |
| `b90967936`     | skipped    | -            | chore: generate                                                                                                                                  |
| `b75a89776`     | integrated | -            | refactor: migrate src/lsp/client.ts from Bun.file() to Filesystem module (#14137)                                                                |
| `97520c827`     | skipped    | -            | refactor: migrate src/provider/models.ts from Bun.file()/Bun.write() to Filesystem module (#14131)                                               |
| `48dfa45a9`     | skipped    | -            | refactor: migrate src/util/log.ts from Bun.file() to Node.js fs module (#14136)                                                                  |
| `6fb4f2a7a`     | skipped    | -            | refactor: migrate src/cli/cmd/tui/thread.ts from Bun.file() to Filesystem module (#14135)                                                        |
| `5d12eb952`     | skipped    | -            | refactor: migrate src/shell/shell.ts from Bun.file() to statSync (#14134)                                                                        |
| `359360ad8`     | skipped    | -            | refactor: migrate src/provider/provider.ts from Bun.file() to Filesystem module (#14132)                                                         |
| `ae398539c`     | skipped    | -            | refactor: migrate src/session/instruction.ts from Bun.file() to Filesystem module (#14130)                                                       |
| `5fe237a3f`     | skipped    | -            | refactor: migrate src/skill/discovery.ts from Bun.file()/Bun.write() to Filesystem module (#14133)                                               |
| `088eac9d4`     | integrated | -            | fix: opencode run crashing, and show errored tool calls in output (#14206)                                                                       |
| `c16207488`     | integrated | -            | chore: skip PR standards checks for PRs created before Feb 18 2026 6PM EST (#14208)                                                              |
| `57b63ea83`     | skipped    | -            | refactor: migrate src/session/prompt.ts from Bun.file() to Filesystem/stat modules (#14128)                                                      |
| `a8347c376`     | skipped    | -            | refactor: migrate src/storage/db.ts from Bun.file() to statSync (#14124)                                                                         |
| `9e6cb8910`     | skipped    | -            | refactor: migrate src/mcp/auth.ts from Bun.file()/Bun.write() to Filesystem module (#14125)                                                      |
| `819d09e64`     | skipped    | -            | refactor: migrate src/storage/json-migration.ts from Bun.file() to Filesystem module (#14123)                                                    |
| `a624871cc`     | skipped    | -            | refactor: migrate src/storage/storage.ts from Bun.file()/Bun.write() to Filesystem module (#14122)                                               |
| `bd52ce564`     | skipped    | -            | refactor: migrate remaining tool files from Bun.file() to Filesystem/stat modules (#14121)                                                       |
| `270b807cd`     | skipped    | -            | refactor: migrate src/tool/edit.ts from Bun.file() to Filesystem module (#14120)                                                                 |
| `36bc07a5a`     | skipped    | -            | refactor: migrate src/tool/write.ts from Bun.file() to Filesystem module (#14119)                                                                |
| `14c098941`     | skipped    | -            | refactor: migrate src/tool/read.ts from Bun.file() to Filesystem module (#14118)                                                                 |
| `ba53c56a2`     | integrated | -            | tweak(ui): combine diffs in review into one group                                                                                                |
| `9c7629ce6`     | integrated | -            | Update oc-2.json                                                                                                                                 |
| `4a8bdc3c7`     | integrated | -            | tweak(ui): group edited files list styling                                                                                                       |
| `fd61be407`     | integrated | -            | tweak(ui): show added diff counts in review                                                                                                      |
| `a30105126`     | integrated | -            | tweak(ui): tighten review diff file info gap                                                                                                     |
| `40f00ccc1`     | integrated | -            | tweak(ui): use chevron icons for review diff rows                                                                                                |
| `44049540b`     | integrated | -            | tweak(ui): add open-file tooltip icon                                                                                                            |
| `3d0f24067`     | integrated | -            | tweak(app): tighten prompt dock padding                                                                                                          |
| `5d8664c13`     | integrated | -            | tweak(app): adjust session turn horizontal padding                                                                                               |
| `6042785c5`     | integrated | -            | tweak(ui): rtl-truncate edited file paths                                                                                                        |
| `802ccd378`     | integrated | -            | tweak(ui): rotate collapsible chevron icon                                                                                                       |
| `3a07dd8d9`     | skipped    | -            | refactor: migrate src/project/project.ts from Bun.file() to Filesystem/stat modules (#14126)                                                     |
| `568eccb4c`     | skipped    | -            | Revert: all refactor commits migrating from Bun.file() to Filesystem module                                                                      |
| `d62045553`     | integrated | -            | app: deduplicate allServers list                                                                                                                 |
| `11a37834c`     | skipped    | -            | tui: ensure onExit callback fires after terminal output is written                                                                               |
| `3a416f6f3`     | integrated | -            | sdk: fix nested exports transformation in publish script                                                                                         |
| `189347314`     | integrated | -            | fix: token substitution in OPENCODE_CONFIG_CONTENT (alternate take) (#14047)                                                                     |
| `4b878f6ae`     | skipped    | -            | chore: generate                                                                                                                                  |
| `308e50083`     | skipped    | -            | tweak: bake in the aws and google auth pkgs (#14241)                                                                                             |
| `c7b35342d`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `d07f09925`     | integrated | -            | fix(app): terminal rework (#14217)                                                                                                               |
| `885d71636`     | integrated | -            | desktop: fetch defaultServer at top level                                                                                                        |
| `d2d5f3c04`     | integrated | -            | app: fix typecheck                                                                                                                               |
| `38f7071da`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `8ebdbe0ea`     | integrated | -            | fix(core): text files missclassified as binary                                                                                                   |
| `338393c01`     | integrated | -            | fix(app): accordion styles                                                                                                                       |
| `0fcba68d4`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `02a949506`     | skipped    | -            | Remove use of Bun.file (#14215)                                                                                                                  |
| `08a2d002b`     | skipped    | -            | zen: gemini 3.1 pro                                                                                                                              |
| `6b8902e8b`     | integrated | -            | fix(app): navigate to last session on project nav                                                                                                |
| `56dda4c98`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `3c21735b3`     | skipped    | -            | refactor: migrate from Bun.Glob to npm glob package                                                                                              |
| `f2858a42b`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `50883cc1e`     | integrated | -            | app: make localhost urls work in isLocal                                                                                                         |
| `af72010e9`     | skipped    | -            | Revert "refactor: migrate from Bun.Glob to npm glob package"                                                                                     |
| `850402f09`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `91f8dd5f5`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `5364ab74a`     | skipped    | -            | tweak: add support for medium reasoning w/ gemini 3.1 (#14316)                                                                                   |
| `7e35d0c61`     | skipped    | -            | core: bump ai sdk packages for google, google vertex, anthropic, bedrock, and provider utils (#14318)                                            |
| `cb8b74d3f`     | skipped    | -            | refactor: migrate from Bun.Glob to npm glob package (#14317)                                                                                     |
| `8b9964879`     | integrated | -            | chore: update nix node_modules hashes                                                                                                            |
| `00c079868`     | integrated | -            | test: fix discovery test to boot up server instead of relying on 3rd party (#14327)                                                              |
| `1867f1aca`     | skipped    | -            | chore: generate                                                                                                                                  |
| `b64d0768b`     | skipped    | -            | docs(ko): improve wording in ecosystem, enterprise, formatters, and github docs (#14220)                                                         |
| `190d2957e`     | integrated | -            | fix(core): normalize file.status paths relative to instance dir (#14207)                                                                         |
| `3d9f6c0fe`     | integrated | -            | feat(i18n): update Japanese translations to WSL integration (#13160)                                                                             |
| `7fb2081dc`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `7729c6d89`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `40a939f5f`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `f8dad0ae1`     | integrated | -            | fix(app): terminal issues (#14329)                                                                                                               |
| `49cc872c4`     | integrated | -            | chore: refactor composer/dock components (#14328)                                                                                                |
| `c76a81434`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `1a1437e78`     | integrated | -            | fix(github): action branch detection and 422 handling (#14322)                                                                                   |
| `04cf2b826`     | integrated | -            | release: v1.2.7                                                                                                                                  |
| `dd011e879`     | integrated | -            | fix(app): clear todos on abort                                                                                                                   |
| `7a42ecddd`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `824ab4cec`     | skipped    | -            | feat(tui): add custom tool and mcp call responses visible and collapsable (#10649)                                                               |
| `193013a44`     | skipped    | -            | feat(opencode): support adaptive thinking for claude sonnet 4.6 (#14283)                                                                         |
| `686dd330a`     | skipped    | -            | chore: generate                                                                                                                                  |
| `fca016648`     | integrated | -            | fix(app): black screen on launch with sidecar server                                                                                             |
| `f2090b26c`     | integrated | -            | release: v1.2.8                                                                                                                                  |
| `cb5a0de42`     | integrated | -            | core: remove User-Agent header assertion from LLM test to fix failing test                                                                       |
| `d32dd4d7f`     | skipped    | -            | docs: update providers layout and Windows sidebar label                                                                                          |
| `ae50f24c0`     | skipped    | -            | fix(web): correct config import path in Korean enterprise docs                                                                                   |
| `01d518708`     | skipped    | -            | remove unnecessary deep clones from session loop and LLM stream (#14354)                                                                         |
| `8ad60b1ec`     | skipped    | -            | Use structuredClone instead of remeda's clone (#14351)                                                                                           |
| `d2d7a37bc`     | integrated | -            | fix: add missing id/sessionID/messageID to MCP tool attachments (#14345)                                                                         |
| `998c8bf3a`     | integrated | -            | tweak(ui): stabilize collapsible chevron hover                                                                                                   |
| `a3181d5fb`     | integrated | -            | tweak(ui): nudge edited files chevron                                                                                                            |
| `ae98be83b`     | integrated | -            | fix(desktop): restore settings header mask                                                                                                       |
| `63a469d0c`     | integrated | -            | tweak(ui): refine session feed spacing                                                                                                           |
| `8b99ac651`     | integrated | -            | tweak(ui): tone down reasoning emphasis                                                                                                          |
| `8d781b08c`     | integrated | -            | tweak(ui): adjust session feed spacing                                                                                                           |
| `1a329ba47`     | skipped    | -            | fix: issue from structuredClone addition by using unwrap (#14359)                                                                                |
| `1eb6caa3c`     | integrated | -            | release: v1.2.9                                                                                                                                  |
| `04a634a80`     | integrated | -            | test: merge test files into a single file (#14366)                                                                                               |
| `d86c10816`     | skipped    | -            | docs: clarify tool name collision precedence (#14313)                                                                                            |
| `1c2416b6d`     | integrated | -            | desktop: don't spawn sidecar if default is localhost server                                                                                      |
| `443214871`     | integrated | -            | sdk: build to dist/ instead of dist/src (#14383)                                                                                                 |
| `296250f1b`     | integrated | -            | release: v1.2.10                                                                                                                                 |
| `a04e4e81f`     | integrated | -            | chore: cleanup                                                                                                                                   |
| `93615bef2`     | integrated | -            | fix(cli): missing plugin deps cause TUI to black screen (#14432)                                                                                 |
| `7e1051af0`     | integrated | -            | fix(ui): show full turn duration in assistant meta (#14378)                                                                                      |
| `ac0b37a7b`     | integrated | -            | fix(snapshot): respect info exclude in snapshot staging (#13495)                                                                                 |
| `1de12604c`     | integrated | -            | fix(ui): preserve url slashes for root workspace (#14294)                                                                                        |
| `241059302`     | integrated | -            | fix(github): support variant in github action and opencode github run (#14431)                                                                   |
| `7e0e35af3`     | skipped    | -            | chore: update agent                                                                                                                              |
| `4e9ef3ecc`     | integrated | -            | fix(app): terminal issues (#14435)                                                                                                               |
| `7e681b0bc`     | integrated | -            | fix(app): large text pasted into prompt-input causes main thread lock                                                                            |
| `7419ebc87`     | skipped    | -            | feat: add list sessions for all sessions (experimental) (#14038)                                                                                 |
| `7867ba441`     | integrated | -            | chore: generate                                                                                                                                  |
| `92ab4217c`     | integrated | -            | desktop: bring back -i in sidecar arguments                                                                                                      |
