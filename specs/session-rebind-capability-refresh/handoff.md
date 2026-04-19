# Handoff: session-rebind-capability-refresh

## Execution Contract

Executor (human engineer or autonomous build agent) acting on this handoff must:

1. **Read before touch** — load `proposal.md`, `spec.md`, `design.md` (所有 15 個 DDs), `idef0.json`, `grafcet.json`, `c4.json`, `sequence.json`, `data-schema.json`, `tasks.md` 進 context. 另掃 `specs/architecture.md` 的「Mandatory Skills Preload Pipeline」段做為上游 baseline.
2. **Backup first** — AGENTS.md 第二條强制：Phase 1.1 必須先做 XDG backup，否則不得進入 Phase 2 以後任何程式碼動作。
3. **Follow tasks.md phase order** — 嚴守 plan-builder §16: TodoWrite 一次只載一個 phase 的 `- [ ]`; phase 間 rollover 自動進行，不等使用者按開始。
4. **No silent fallback** — AGENTS.md 第一條. 任何 bumpEpoch / reinject / file read 失敗必須 loud log + RuntimeEvent，禁止吞異常。
5. **Cross-check every file edit** — 改 prompt.ts / instruction.ts 前都先 `grep` 現有 usage 確認沒有其他 caller 依賴 TTL 行為；驗過再改。
6. **Sync after each task** — 每次 `- [x]` 後跑 `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/session-rebind-capability-refresh/`。

## Required Reads

Phase 1 前必讀（按順序）：

- `packages/opencode/src/session/prompt.ts` — 至少讀 line 780-1070（runLoop top + early break）+ 1640-1690（我的既有 hook 位置）
- `packages/opencode/src/session/instruction.ts` — 整個檔，重點是 `system()` 的 10s TTL cache 邏輯
- `packages/opencode/src/session/mandatory-skills.ts` — 整個檔，了解 forwarder 要 proxy 哪些呼叫
- `packages/opencode/src/session/skill-layer-registry.ts` — 熟悉 pin/unpin/peek API
- `packages/opencode/src/session/llm.ts` 的 skill-layer-seam 呼叫段（line 440-480）
- `packages/opencode/src/system/runtime-event-service.ts` — event emit API
- `packages/opencode/src/server/routes/session.ts` — 找到 POST endpoint 模板
- `packages/opencode/src/command/index.ts` — slash command 註冊模式
- `packages/opencode/src/tool/index.ts` + `skill.ts` — tool 定義範本
- `specs/architecture.md` → 「Mandatory Skills Preload Pipeline」 section
- `specs/mandatory-skills-preload/design.md` → DD-1..DD-10 了解上一階段決策脈絡

## Scope Boundaries (do NOT do)

- 不重寫 SessionCompaction / SharedContext / rebind checkpoint 的對話層壓縮邏輯（DD-4 與 NG1 反覆強調）
- 不引入 file-mtime watcher 自動 bump（Phase 2 extend mode 才做，現在只要 rebind event 觸發）
- 不推翻 per-session isolation — 不做 global epoch、不做 cross-session propagation（DD-1）
- 不自動對 skill-finder/mcp-finder install 事件 bump epoch（DD-14）
- 不讓 subagent 繼承 parent rebind event（DD-13）
- 不嘗試 Bun module hot-reload；改 runtime code 仍需 `webctl.sh restart`
- 不改 UI dashboard layout 的 React/Solid 結構；只加 event 訂閱
- 不刪 `InstructionPrompt.systemCache`；只改 cache key 判斷邏輯（保留既有 state cache 結構）

## Stop Gates In Force

執行者必須停下並請使用者決定的情境：

1. **Backup 失敗** — `~/.config/opencode/` 不可讀 / 目的地無權寫 / 磁碟滿。不 proceed。
2. **Phase 4.3 行為改變偵測** — 若修改既有 mandatory-skills hook 讓現有 session 的 plan-builder pin 意外丟失，停下回 user 請他確認（回退為 Phase 3 edits）。
3. **Phase 6 UI signal 認證邊界** — 若發現 daemon 的 Unix socket 原本有其他 uid 可連（gateway mode），DD-9 前提失效，停下請 user 決定 auth 機制。
4. **Provider switch 順序衝突** — 若 DD-4 要求的「能力層 before checkpoint」實作時發現與既有 compactWithSharedContext 的 incoming model 假設衝突，停下 refactor。
5. **Cache miss storm** — 整合測試顯示 cache miss 頻率超預期（> 10 次/分鐘 per session）→ review epoch 邏輯，可能有 bug 沒命中。
6. **Runtime regression** — 跑 `bun test` 有既有 test fail 且無法解釋，停下報告；禁止 `.skip` 跳過。
7. **UI 改動範圍外溢** — Phase 6 frontend 改動開始碰到 dashboard layout / state 重構，立刻停 — 那超出 scope。

## Execution-Ready Checklist

Phase 1.1 前確認：

- [ ] 當前 branch 狀態清楚（`git status` 正常）
- [ ] `.state.json` 在 `planned`
- [ ] 使用者已確認 beta-workflow build surface
- [ ] `bun --version` OK
- [ ] Backup 目的地可寫：`touch ~/.config/opencode.bak-test && rm ~/.config/opencode.bak-test`
- [ ] miatdiagram artifact 已在 designed 階段產出（idef0 + grafcet），不需 Phase 內重跑
- [ ] 讀完 Required Reads 所有檔案（至少掃過 table of contents）

## Per-Task Ritual

每個 checkbox toggle 後：

1. 立刻 `- [x]` in `specs/session-rebind-capability-refresh/tasks.md`
2. `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/session-rebind-capability-refresh/`
3. 讀 sync output：
   - `clean` → 繼續
   - `warned` → 照 plan-builder §16.3 決策樹
4. TodoWrite item 同步改 `completed`
5. phase 最後一項完成時：寫 phase summary 進 `docs/events/event_<YYYYMMDD>_session_rebind_capability_refresh.md`

## State Promotion Plan

| Transition | Trigger |
|---|---|
| planned → implementing | 1.1 Backup completed（第一個 `- [x]`） |
| implementing → implementing | 每個 task closure（history-only via sync） |
| implementing → verified | 所有 tasks.md checkbox 完成 + §9 Acceptance 手動驗證 evidence 收齊（event log 記錄） |
| verified → living | beta-workflow fetch-back 合入 main 成功 |

## Rollback

- 中途要退版：`git revert` 相關 commits（禁止 `git reset --hard`）
- 若 runtime 改壞造成 session 無法開：暫時 `export OPENCODE_DISABLE_REBIND_EPOCH=1`（若實作支援此 flag）或回到前一個 commit 重啟 daemon
- 備份還原只在使用者明確要求時動作（第二條）
- 若 scope 發散嚴重：`plan-promote.ts --mode refactor` 重啟 spec；原 artifacts 會進 `.history/refactor-<date>/`

## Phase Summary Structure (§16.4)

每個 phase close 寫進 `docs/events/event_<YYYYMMDD>_session_rebind_capability_refresh.md`:

- **Phase**: `N — <name>`
- **Done**: task IDs (e.g. 2.1, 2.2, 2.3, 2.4, 2.5)
- **Key decisions**: 新 DD-N 或改動 DD 
- **Validation**: `bun test` 通過清單 / manual 驗證
- **Drift**: sync warn 與解決方式
- **Remaining**: 下一階段需求
