# Event: cms codex recovery

## 需求

- 追查 codex websocket / `LLM 狀態` `WS/HTTP` 顯示為何在目前 `cms` 消失。
- 判定 `cms` 是否發生 branch 偏移，並找回走歪前最新進度。
- 在不碰主工作樹未提交變更的前提下，建立 recovery branch 並開始救回最近 24 小時內值得保留的後續發展。

## 範圍

IN:

- `/home/pkcs12/projects/opencode/.git`
- `/home/pkcs12/projects/opencode/specs/architecture.md`
- `/home/pkcs12/projects/opencode/docs/events/`
- `cms` / `recovery/*` / `backup/*` branches
- `/home/pkcs12/projects/opencode-recovery-20260401-183212`

OUT:

- 不直接重寫 `cms` branch ref
- 不對主工作樹做 `reset` / `stash`
- 不一次性把目前 `cms` 整條 merge 回 recovery

## 任務清單

- [x] 追查 `WS/HTTP transport label` 是否曾存在於 `cms`
- [x] 確認 `cms` 是否被 branch-pointer 操作拉離舊 codex 線
- [x] 找出走歪前最新合理 recovery 基準點
- [x] 建立 backup / recovery branches
- [x] 建立獨立 recovery worktree
- [x] 救回低風險最近 24 小時後續提交
- [ ] 決定如何處理主工作樹未提交的 `claude-cli anthropic audit` 修補

## Debug Checkpoints

### Baseline

- 使用者觀察到 codex websocket status 判斷欄位曾顯示 `WS` 狀態，但目前 `LLM 狀態` 只剩 `OK`。
- 初步懷疑是近期 codex websocket 相關功能在測試／merge 後又被回退。

### Instrumentation Plan

- 用 `git log -S/-G`、`git branch --contains`、`git reflog show cms` 重建時間線。
- 對照目前 Web/TUI 狀態欄位來源，區分是「明確 revert」還是「branch 偏移導致目前主線看不到」。
- 在不碰髒工作樹的前提下，先保全 branch refs，再用獨立 worktree 做 recovery。

### Execution

- 確認 `c08b509b3`（`fix(codex): prevent cascade account burn + rotation-aware auth + WS/HTTP transport label`）曾直接出現在 `cms` reflog：
  - `cms@{2026-03-30 11:43:04 +0800}`
- 確認 `cms` 在 `2026-04-01 15:18:31 +0800` 出現：
  - `reset: moving to beta/llm-packet-debug`
- 判定這不是單純 merge 後被 revert，而是 `cms` branch pointer 被拉到另一條歷史，讓舊 codex 線脫離目前主線視角。
- 以 `081595aa1` 作為走歪前較新的 recovery 基準點。
- 建立 branch refs：
  - `backup/cms-current-20260401-183212` -> `33700417d`
  - `recovery/cms-codex-20260401-183212` -> `081595aa1`
- 確認主工作樹不乾淨，因此不在主工作樹執行 recovery：
  - modified: `packages/app/src/context/models.tsx`
  - untracked: `docs/events/event_20260401_claude_cli_anthropic_audit.md`
  - untracked: `packages/app/src/context/model-preferences.test.ts`
  - untracked: `packages/app/src/context/model-preferences.ts`
- 建立獨立 recovery worktree：
  - `/home/pkcs12/projects/opencode-recovery-20260401-183212`
- 已救回最近 24 小時內的低風險後續提交：
  - `e875eacfa` from `4b7afb699` `fix(webapp): stop anthropic blacklist from disabling claude-cli`
  - `cdcd0f823` `recovery(debug): manually integrate llm packet checkpoints`
- `f3d1a00f2` 不能直接 cherry-pick，因為在 `packages/opencode/src/session/llm.ts` 與 recovery 線演進衝突；已改用手動整合，只保留低風險 observability checkpoints。
- 後續盤點確認：`recovery` 已天然包含走歪前的 auth/provider、codex-ws、efficiency/compaction 主體；走歪後真正有價值的新功能性變更僅上述兩項，剩餘差集主要是 templates/refs/submodule 類後勤提交。
- 使用者要求新增硬規則：`beta/*` 與 `test/*` 分支在測試完成且 merge/fetch-back 回主線後必須立即刪除，不得長留。

### Root Cause

- 根因不是 `c08b509b3` 後續被單一 revert commit 回退。
- 根因是 `cms` 在 `2026-04-01 15:18:31 +0800` 被 `reset` 到 `beta/llm-packet-debug`，導致舊 codex/cms 線上的 61 個 commits 不再位於目前 `cms` 祖先鏈上。
- 使用者體感上的「測完 merge 回 cms 卻又不見」是因為該功能一度真的進過 `cms`，但之後 `cms` 指標被拉走。
- 促成事故的流程缺口之一，是 stale `beta/test` 分支在 merge-back 後仍然存活，後續 branch-pointer 操作有機會把 `cms` 誤拉回舊 execution surface。

### Validation

- reflog 證據：
  - `cms@{2026-03-30 11:43:04 +0800}: commit: fix(codex): prevent cascade account burn + rotation-aware auth + WS/HTTP transport label`
  - `cms@{2026-04-01 15:18:31 +0800}: reset: moving to beta/llm-packet-debug`
- branch / ancestry 證據：
  - `backup/cms-current-20260401-183212` -> `33700417d`
  - `recovery/cms-codex-20260401-183212` -> `081595aa1`
- recovery worktree 證據：
  - `/home/pkcs12/projects/opencode-recovery-20260401-183212`
  - recovery HEAD: `cdcd0f823`
- 救回提交驗證：
  - `git diff --check` on recovery worktree ✅
  - `git log -2` on recovery worktree:
    - `cdcd0f823 recovery(debug): manually integrate llm packet checkpoints`
    - `e875eacfa fix(webapp): stop anthropic blacklist from disabling claude-cli`
- 流程修補：
  - 已同步更新 repo/template beta workflow 規範，新增 `beta/*` / `test/*` merge-back 後必刪的 branch lifecycle rule。

## 結論

- 判定：`cms` 確實發生 branch 偏移；不是整個 codex branch 遺失，而是 `cms` branch ref 被拉到另一條歷史。
- 走歪前最新合理基準已保全並開出 recovery branch。
- recovery 線已先救回兩項最近 24 小時內的低風險後續發展：
  - claude-cli webapp blacklist 修補
  - llm packet debug checkpoints（手動整合版）
- 其餘 codex runtime / efficiency / prompt / compaction 大功能群經盤點後已確認屬於 recovery 祖先主體，不是當前缺口。
- 新的流程硬規則已確立：`beta/*`、`test/*` 分支一律在測試完成且 merge/fetch-back 回主線後立即刪除。

## 2026-04-01 Recovery 主工作樹切換與 runtime/config 修補續記

### 需求

- 將主工作樹切回 `recovery/cms-codex-20260401-183212` 作為新的實際工作面。
- 確認 `node` 無法執行是否為 shell 載入問題。
- 在不再擴大測試導向修補的前提下，保留有產品/runtime 價值的修復，並同步文件。

### 範圍

IN:

- `/home/pkcs12/projects/opencode`
- `recovery/cms-codex-20260401-183212`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/project/instance.ts`
- `packages/opencode/src/bus/index.ts`
- `packages/opencode/src/server/killswitch/service.ts`
- `packages/opencode/src/mcp/apps/gauth.ts`
- `packages/opencode/src/server/routes/mcp.ts`
- `scripts/test-with-baseline.ts`

OUT:

- 不繼續擴大 `workflow-runner` / `planner-reactivation` / Smart Runner / route auth 等測試導向行為修補
- 不以 full-suite 全綠作為本輪收尾門檻

### 任務清單

- [x] 確認主工作樹切到 `recovery/cms-codex-20260401-183212`
- [x] 追查 `node` 執行失敗的環境根因
- [x] 在 login shell 下重跑並通過全 repo `typecheck`
- [x] 驗證 web runtime health
- [x] 修正 root test wrapper 的 repo root 計算
- [x] 修正 config migration / nested non-git config merge 邊界
- [x] 補強 `Instance.project` / Bus context fallback 韌性
- [x] 修正 managed app auth / error data contract 取值
- [x] 盤點目前變更並停止擴大測試導向修補
- [x] 同步 event / architecture 文件

### Debug Checkpoints

#### Environment

- non-login / non-interactive shell 下 `node` 不在 PATH。
- 根因是 `~/.bashrc` 以非互動 shell guard 提前 `return`，而 `nvm` 初始化在 guard 後方。
- `bash -lc` 可透過 `~/.profile` 載入 `nvm`，恢復 `node`：
  - `/home/pkcs12/.nvm/versions/node/v20.19.6/bin/node`

#### Execution

- 主工作樹已確認切到 `recovery/cms-codex-20260401-183212`。
- 全 repo `bun turbo typecheck` 已通過。
- `webctl.sh status` 顯示 gateway / daemon / health 正常。
- `scripts/test-with-baseline.ts` 的 repo root 從 `../..` 修正為 `..`，root test 入口不再因錯誤 cwd 失敗。
- `packages/opencode/src/config/config.ts` 已保留的產品向修補：
  - 恢復 `autoshare: true` → `share: "auto"` 相容遷移
  - 修正 non-git nested project 可向上合併父層 config 的搜尋邊界
- `packages/opencode/src/project/instance.ts` / `packages/opencode/src/bus/index.ts` 已補強缺值 fallback，避免 runtime context 缺值直接崩潰。
- `packages/opencode/src/server/killswitch/service.ts` 已把 seq 追蹤收斂到 `requestID + sessionID`。
- `packages/opencode/src/mcp/apps/gauth.ts` / `packages/opencode/src/server/routes/mcp.ts` 已對齊現行 managed app error contract。

#### Decision

- 使用者明確要求：延緩所有跟測試有關的程式修復。
- 因此本輪收尾只保留 branch/runtime/config/runtime-safety 類修補，不再延伸處理 workflow/planner/Smart Runner/route auth 等測試導向行為回歸。

### Validation

- Branch:
  - `git branch --show-current` -> `recovery/cms-codex-20260401-183212`
- Environment:
  - `bash -lc 'command -v node && node -v'` -> `v20.19.6`
- Typecheck:
  - `bash -lc 'cd /home/pkcs12/projects/opencode && bun turbo typecheck'` ✅
- Web runtime:
  - `bash -lc '"/home/pkcs12/projects/opencode/webctl.sh" status'` -> healthy ✅
- Config focused validation:
  - `bun test ./packages/opencode/test/config/config.test.ts` -> `60 pass, 0 fail`
- Architecture Sync:
  - Updated: `specs/architecture.md` 已補入 config resolution 與 runtime state initialization safety 的長期規則。

## Architecture Sync

- Updated: `specs/architecture.md` 已補入 beta/test disposable branch lifecycle 規則，明確禁止 merge-back 後長留 stale execution branches。

## 2026-04-01 Provider List「模型提供者」缺漏修補續記

### 需求

- 從 `cms` commit history 找回昨天針對 provider list / 「模型提供者」的專門修復。
- 將缺漏的最小修補回帶到目前 `recovery/cms-codex-20260401-183212`，避免 provider list 漏掉 `claude-cli`。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/.git`
- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/provider.ts`
- `/home/pkcs12/projects/opencode/docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不擴大 cherry-pick 無關前端或其他 provider 變更
- 不新增 commit
- 不處理既有 generated/typecheck 雜訊

### 任務清單

- [x] 從 `cms` 歷史定位 provider list 修復 commit
- [x] 判定 recovery 缺漏是否僅為 `claude-cli` provider registration
- [x] 將最小修補套回 `packages/opencode/src/provider/provider.ts`
- [x] 執行 provider focused validation
- [x] 同步 event / architecture sync 記錄

### Debug Checkpoints

#### Baseline

- 使用者回報 recovery branch 的 provider list「模型提供者」缺少昨天已修復的內容。
- 畫面症狀對應 `claude-cli` 未正確出現在 provider list。

#### Instrumentation Plan

- 以 `git log` / `git show` 在 `cms` 歷史中找出昨天專門修 provider list 的 commit。
- 比對 recovery 目前內容，確認是單一缺漏還是整批 provider UI 修復未回來。
- 若只缺最小 runtime registration 修補，直接手動回補，不擴大 cherry-pick 範圍。

#### Execution

- 定位缺漏 commit：`addb248b2` `fix(claude-cli): call mergeProvider to register claude-cli in providers map`。
- 另外比對確認前端 related fixes `e875eacfa` / `30ba8cac1` 已存在於 recovery，不屬本次缺口。
- 實際缺漏位於 `packages/opencode/src/provider/provider.ts`：
  - 在 `database["claude-cli"]` 存在時補回 `mergeProvider("claude-cli", { source: "custom" })`
- 這次只回補最小必要 runtime provider registration，未引入其他 commit 內容。

#### Root Cause

- recovery branch 缺的不是整批 provider list 改動，而是昨天一個專門修復 `claude-cli` provider registration 的最小 commit 未被帶回。
- 因 `claude-cli` 只有 database entry、未呼叫 `mergeProvider(...)` 註冊進 providers map，導致 provider list / 模型提供者 UI 無法正確顯示該提供者。

#### Validation

- Focused test:
  - `bun test /home/pkcs12/projects/opencode/packages/opencode/src/provider/models.test.ts` ✅
- TypeScript:
  - `bun x tsc -p /home/pkcs12/projects/opencode/tsconfig.json --noEmit` ❌
  - 失敗點位於 `packages/opencode-codex-provider/build/CMakeFiles/*/compiler_depend.ts`，為 repo 既有/generated typecheck 問題，非本次 provider 修補引入。
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次僅為既有 provider registration 修補回帶，未改變長期模組邊界/資料流）

## 2026-04-01 Provider List「模型提供者」UI rename / polish 回補續記

### 需求

- 找回昨天把 provider dialog 從「連接提供者」改名為「模型提供者」並做選單界面優化的前端 commit。
- 只回補與 provider selector UI rename / polish 直接相關的前端變更到目前 `recovery/cms-codex-20260401-183212`。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/.git`
- `/home/pkcs12/projects/opencode/packages/app/src/i18n/zht.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-provider.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/hooks/use-providers.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/components/dialog-custom-provider.tsx`

OUT:

- 不整批帶入 `4264f4133` 內較大的 backend CRUD / refreshProviders 依賴
- 不變更 server/runtime provider CRUD 契約
- 不新增 commit

### 任務清單

- [x] 重新定位昨天的 provider list UI commit
- [x] 判定 recovery 缺漏的前端檔案與最小相依
- [x] 回補「模型提供者」rename 與 dialog polish
- [x] 執行前端 focused typecheck
- [x] 同步 event / architecture sync 記錄

### Debug Checkpoints

#### Baseline

- 使用者指出前一輪鎖定錯誤：缺漏目標不是 `claude-cli` registration，而是 provider dialog「連接提供者」→「模型提供者」與界面優化 commit。

#### Instrumentation Plan

- 以 i18n 文案與 provider dialog 元件為主軸，從 `cms` 昨天歷史中定位 UI rename/polish commit。
- 比對 recovery 現況，只回補可獨立成立的前端變更，避免帶入缺少 backend 依賴的 CRUD 大改。

#### Execution

- 定位正確目標 commit：`4264f4133` `feat(provider): custom provider CRUD, model visibility, and UI fixes`。
- 只挑出與「模型提供者」UI rename / polish 直接相關的最小前端變更：
  - `packages/app/src/i18n/zht.ts`
    - `command.provider.connect` 改為「模型提供者」
  - `packages/app/src/components/dialog-select-provider.tsx`
    - 補回可調整大小 dialog + localStorage 尺寸記憶
    - 補回 provider row 版面優化與 custom provider edit mode 入口
  - `packages/app/src/hooks/use-providers.ts`
    - 補回 `providers().all`，讓 custom providers 出現在 provider list
  - `packages/app/src/components/dialog-custom-provider.tsx`
    - 補回最小 `editProviderId` 支援
- 保留 recovery 既有儲存流程，未把同 commit 內 backend CRUD / refreshProviders 相關部分帶回。

#### Root Cause

- `recovery` 缺漏的是 `4264f4133` 中 provider selector 前端體驗那一批變更，而不是單純 runtime provider registration。
- 因該 commit 內混有較大的 CRUD/runtime 依賴，若不做最小切片回補，容易誤帶入不完整後端契約。

#### Validation

- Frontend typecheck:
  - `bun x tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅
- Code evidence:
  - `packages/app/src/i18n/zht.ts:30` → `模型提供者`
  - `packages/app/src/components/dialog-select-provider.tsx:16` → `SIZE_KEY`
  - `packages/app/src/components/dialog-select-provider.tsx:108` → `editProviderId={x.id}`
  - `packages/app/src/hooks/use-providers.ts:30` → `providers().all`
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為既有 provider dialog 前端體驗回補，未新增長期架構邊界或資料流）

## 2026-04-01 cms branch overwrite / drift audit

### 需求

- 盤點 `cms` 歷史中主線 branch pointer 被拉偏、reset 到 stale beta/test/worktree surface、或造成既有 commit 脫離目前主線祖先鏈的事故次數。
- 評估每次掉失範圍的可恢復性，區分 confirmed / probable。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/.git`
- `cms` reflog / local refs / remote refs
- `beta/*` / `test/*` / `recovery/*` / `backup/*`

OUT:

- 不修改任何 git refs
- 不直接做歷史救回或批次 cherry-pick
- 不將所有 unreachable object 都視為已確認事故

### 任務清單

- [x] 盤點 `cms` reflog 中 reset / pointer move 證據
- [x] 交叉比對 local/remote refs 與掉失 commit 範圍
- [x] 區分 confirmed overwrite、probable rollback/reset、pointer jump 無損事件
- [x] 評估 recoverability
- [x] 記錄 root-cause pattern 與後續守門建議

### Debug Checkpoints

#### Baseline

- 使用者觀察到已發現的功能回歸不只一次，懷疑還有更多未被發現的靜默掉失。

#### Instrumentation Plan

- 以 `git reflog show cms --date=iso` 為主證據，搭配 ancestry / branch containment / fsck 交叉比對。
- 僅把能連到 `cms` pointer drift/reset 的事件列為事故候選，不把所有 unreachable object 直接視為主線覆蓋。

#### Execution

- 審計結果：
  - **1 次 confirmed overwrite/drift**
  - **4 次 probable rollback/reset**
  - **1 次 probable pointer jump（無實際掉失）**
- 最大事故：
  - `2026-04-01 15:18:31` `reset: moving to beta/llm-packet-debug`
  - `old=3ab872842` → `new=f3d1a00f2`
  - 掉失 **138 commits**
  - 代表 commit 包含：
    - `c08b509b3` WS/HTTP transport label
    - `4264f4133` 「模型提供者」UI fixes
    - `addb248b2` claude-cli provider registration
    - `515a1ca7d` claude-provider merge
- 其他 probable reset/rollback：
  - `2026-03-31 02:34:08` `reset: moving to HEAD~1`（1 commit，後續已有新 SHA 重落）
  - `2026-03-30 15:50:47` `reset: moving to 7105706cb`（5 commits，後續已有等價 topic commits）
  - `2026-03-26 01:14:57` `reset: moving to HEAD~1`（1 commit，後續 fast-forward / 新 SHA 重落）
  - `2026-03-19 17:56:56` `reset: moving to HEAD~1`（21 commits，主體仍在 `remotes/beta/account-manager-refactor`）
- pointer jump 無損事件：
  - `2026-03-20 11:47:32` `reset: moving to 36baa9a606`（掉失 0 commits，但屬異常 pointer move）

#### Root Cause

- 事故模式高度一致：
  1. `beta/*` / `test/*` / worktree execution branches 長留
  2. 後續 `cms` 被 reset / fast-forward / pointer move 到這些 execution surfaces
  3. 有些事件是短暫回退後以新 SHA 重整合
  4. 但 `2026-04-01` 那次明確造成大規模主線視角掉失
- 結論：已知功能回歸並不是孤例；從 git 證據看，`cms` 歷史至少不只一次發生 reset/pointer 異常。

#### Validation

- Commands:
  - `git reflog show cms --date=iso`
  - `git reflog show cms --date=iso | rg 'reset: moving to|merge |Fast-forward|cherry-pick'`
  - `git rev-list --count <new>..<old>`
  - `git branch -a --contains <commit>`
  - `git fsck --full --no-reflogs --unreachable`
- Recoverability summary:
  - confirmed 大規模掉失：**partial → mostly recoverable**（因 `recovery/*` / feature/test refs 仍保有大量內容）
  - 4 次 probable reset/rollback：**recoverable 或 partial but strong**
  - **0 次明確完全不可救**，但部分證據只剩 reflog / remote beta refs，屬 reflog-dependent
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為事故審計與流程結論沉澱，未新增 runtime/module architecture）

## 2026-04-01 beta-workflow skill authority-first rewrite

### 需求

- 重寫 `beta-workflow` skill，明確定義 authoritative mainline 與 beta execution surface 的權限邊界。
- 把 authority mismatch、stale beta reuse、cleanup 缺失改寫成 fail-fast / completion-gate 契約。

### 範圍

IN:

- `/home/pkcs12/.local/share/opencode/skills/beta-workflow/SKILL.md`
- `/home/pkcs12/projects/opencode/templates/skills/beta-workflow/SKILL.md`

OUT:

- 不修改其他 runtime/prompt 檔案
- 不改 git/worktree 狀態

### 任務清單

- [x] 重寫 beta-workflow skill 為 authority-first 契約
- [x] 同步 repo template skill mirror
- [x] 驗證 authority / cleanup / fail-fast 段落存在
- [x] 在 event 記錄這次 skill contract 重寫

### Debug Checkpoints

#### Baseline

- 前述 git audit 顯示 branch overwrite/drift 的主要根因之一，是 AI 在 beta workflow 中容易混淆 mainline authority 與 disposable beta execution surface。

#### Execution

- 已重寫：
  - `/home/pkcs12/.local/share/opencode/skills/beta-workflow/SKILL.md`
  - `/home/pkcs12/projects/opencode/templates/skills/beta-workflow/SKILL.md`
- 新 skill 核心規則：
  - authority SSOT 必須明確列出並重述：
    - `mainRepo`
    - `mainWorktree`
    - `baseBranch`
    - `implementationRepo`
    - `implementationWorktree`
    - `implementationBranch`
    - `docsWriteRepo`
  - `beta/*` / `test/*` 與其 worktree 一律視為 disposable execution surface，不能當 mainline authority
  - build / validate / fetch-back / finalize 前都要先做 authority restatement + admission gate
  - mismatch 一律 fail fast，不可 fallback
  - merge/fetch-back/finalize 後必須刪除 `beta/*` / `test/*` refs 與 disposable worktree，否則不得宣告完成
  - 明確禁止把 implementation branch 當 base branch、猜 main branch 名稱、用 stale beta/test 當 authority source、把主線直接指向 beta/test surface

#### Validation

- Targeted grep/read evidence：
  - authority SSOT：`SKILL.md:18-43`
  - disposable beta/test rule：`SKILL.md:45-55`
  - admission gate：`SKILL.md:57-71`
  - forbidden actions：`SKILL.md:73-85`
  - cleanup as completion gate：`SKILL.md:142-152`
  - stop conditions / fail-fast：`SKILL.md:154-165`
- 本機 skill 與 repo template 內容一致，皆為 165 行版本。
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 workflow skill / template contract 重寫，architecture SSOT 無新增章節）

## 2026-04-01 recovery 現況盤點（相對 4/1 大規模掉失事件）

### 需求

- 盤點目前 `recovery/cms-codex-20260401-183212` 相對於 4/1 掉失前 tip `3ab872842`，還剩多少值得復原的功能切片。
- 明確把剛剛已補回的 provider list UI /「模型提供者」算進 recovered，而不是仍視為缺口。

### 範圍

IN:

- `recovery/cms-codex-20260401-183212`
- `3ab872842`
- provider/webapp、claude-provider/native、runtime/tooling、global onboarding 等主題差集

OUT:

- 不逐條列完全部 42 個 ancestry 差集 commit
- 不直接執行新的復原/merge/cherry-pick

### 任務清單

- [x] 以 4/1 掉失前 tip 比對目前 recovery 差集
- [x] 將差集整理成功能主題而非逐 commit 流水帳
- [x] 標記已恢復 / partial / 未恢復
- [x] 區分高價值功能群與低優先後勤差集
- [x] 更新 event 盤點結果

### Debug Checkpoints

#### Baseline

- 使用者判斷目前 recovery 應已恢復大部分 4/1 重大事件掉失內容，希望知道還剩多少真的需要救。

#### Execution

- 基準：
  - current recovery HEAD：`f6a176187`
  - pre-drift tip：`3ab872842`
  - `git rev-list --left-right --count HEAD...3ab872842` → `8 42`
- 盤點結論：
  - ancestry 上仍少 **42 commits**（非 merge 約 41 條）
  - 但大部分「4/1 重大事件核心功能」已恢復
  - 真正值得優先處理的，已收斂成 **3 個高價值功能群 + 1 個中價值產品群**

#### Recovered / Partial / Missing

- **已恢復**
  1. codex websocket / WS-HTTP / llm packet 主體
  2. provider list UI /「模型提供者」：**recovered（partial from original commit, functionally restored）**
  3. claude-cli provider registration：**recovered（partial）**
  4. 4/1 事故前的主線大方向（codex/auth/provider 基線）大致已回到 recovery 祖先主體

- **高價值仍缺（High）**
  1. Claude Native / claude-provider 原生鏈
     - 代表 commits：`197fc2bd7`、`9321ca7b1`、`809135c30`、`4a4c69488`、`515a1ca7d`
     - 現況：大多仍缺
  2. runtime/context optimization hardening
     - 代表 commits：`7bd35fb27`、`43d2ca35c`、`a34d8027a`、`4a6e10f99`、`eaced345d`
     - 現況：仍缺
  3. rebind / continuation / session hardening
     - 代表 commits：`3fd1ef9b8`、`efc3b0dd9`、`f041f0db8`、`85691d6e3`
     - 現況：仍缺

- **中價值仍缺（Medium）** 4. webapp provider management 後續完善
  - 代表 commits：`dda9738d8`、`cd8238313`、`81f2dc933`、`164930b23`、`9870e4f53`
  - `4264f4133` 其餘 backend CRUD / model visibility 部分仍未完整回來
  - 現況：**partial**
  5. multi-user onboarding / app market / repo-independent user-init
     - 代表 commits：`db1050f06`、`5c18f28fe`、`18793931b`
     - 現況：仍缺，但優先級低於核心 runtime/provider 回補

- **低優先差集（Low）**
  - docs/events、plans、spec promotion、datasheets、template 調整
  - refs/submodule/branding/website 類
  - github-copilot reasoning variants 等功能增量

#### Root Cause / Interpretation

- `42 commits` 不等於 `42 個重要功能未回來`。
- 目前剩餘差集多數已不是 4/1 事故救火核心，而是：
  - 少數高價值能力鏈（claude-provider/native、runtime hardening、session hardening）
  - 一部分 provider manager / onboarding 產品增量
  - 大量 docs/templates/refs 後勤差集

#### Validation

- Commands:
  - `git branch --show-current`
  - `git rev-parse --short HEAD`
  - `git rev-list --left-right --count HEAD...3ab872842`
  - `git log --oneline --decorate --no-merges HEAD..3ab872842`
  - `git diff --stat HEAD..3ab872842`
  - topic-scoped `git log` for provider/webapp, claude-provider/native, runtime/tooling, onboarding/branding
- Code evidence for recovered slices:
  - `packages/app/src/i18n/zht.ts` 有 `模型提供者`
  - `packages/app/src/components/dialog-select-provider.tsx` 有 `editProviderId={x.id}`
  - `packages/app/src/hooks/use-providers.ts` 有 `providers().all`
  - `packages/opencode/src/provider/provider.ts` 有 `mergeProvider("claude-cli", { source: "custom" })`
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 recovery gap inventory，未新增長期架構內容）

## 2026-04-01 AGENTS system-vs-project rule dedupe

### 需求

- 確認 subagent 委派限制若已由 system 層硬性規定，project/template `AGENTS.md` 不應重複宣告。
- 移除 repo/template `AGENTS.md` 中對 system-level subagent 規則的重複記載，避免規範漂移。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/AGENTS.md`
- `/home/pkcs12/projects/opencode/templates/AGENTS.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不修改 global `~/.config/opencode/AGENTS.md`
- 不調整 runtime code，只做規範去重

### 任務清單

- [x] 檢查 repo/template `AGENTS.md` 是否重複 system-level subagent 規則
- [x] 移除重複規範，只保留 project-specific 規則
- [x] 記錄 event

### Validation

- `AGENTS.md`
  - 已移除重複的 subagent count/type 限制，只保留 project-specific 規則
- `templates/AGENTS.md`
  - 已移除重複的 subagent count/type 限制，只保留 project-specific 規則
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 governance dedupe，非架構變更）

## 2026-04-01 apply_patch read-first prompt rule

### 需求

- 將 `apply_patch` 的 prompt 規範改為：更新既有檔案前必須先 `read` 該檔案。
- 降低 patch context 與實際檔案內容脫節時的高頻首輪失敗。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt/instructions.txt`
- `/home/pkcs12/projects/opencode/templates/prompts/session/instructions.txt`
- `/home/pkcs12/projects/opencode/docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不修改 `enablement.json`（其僅登記 capability，不是詳細 prompt 指令面）
- 不修改 repo 外的上游 prompt 注入面

### 任務清單

- [x] 定位 apply_patch 實際 prompt 指令面
- [x] 更新 runtime `instructions.txt`
- [x] 更新 template mirror `instructions.txt`
- [x] 驗證兩者內容已同步
- [x] 記錄 event

### Validation

- Runtime SSOT:
  - `packages/opencode/src/session/prompt/instructions.txt:6`
  - 已新增：更新既有檔案時，`apply_patch` 前必須先在當前回合 `read` 該檔案；新建檔案不受此限制
- Template mirror:
  - `templates/prompts/session/instructions.txt:6`
  - 與 runtime 同步
- Non-target confirmation:
  - `packages/opencode/src/session/prompt/enablement.json` 與 `templates/prompts/enablement.json` 仍只作 capability 登記，未誤改
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 prompt/tooling instruction 更新）

## 2026-04-01 Claude Native first-slice replanning

### 需求

- 第一個 `Claude Native / claude-provider` slice 已觸發 stop gate，需要回到 plan mode 把可執行項目切細、文件化後再執行。

### 範圍

IN:

- `plans/20260401_provider-list-commit/implementation-spec.md`
- `plans/20260401_provider-list-commit/proposal.md`
- `plans/20260401_provider-list-commit/design.md`
- `plans/20260401_provider-list-commit/spec.md`
- `plans/20260401_provider-list-commit/tasks.md`
- `plans/20260401_provider-list-commit/handoff.md`
- `docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不直接撰寫 Claude Native production code
- 不跳過 beta bootstrap 直接在 authoritative recovery worktree 開工

### 任務清單

- [x] 將 Claude Native oversized slice 標記為 blocked evidence
- [x] 把 build 入口改成 beta bootstrap 優先
- [x] 將 Claude Native 拆成 scaffold / auth bridge / loader wiring / activation 子階段
- [x] 同步 implementation-spec / proposal / design / spec / tasks / handoff
- [x] 記錄 event

### Validation

- `plans/20260401_provider-list-commit/tasks.md`
  - 已將原本過大的 Claude Native 首切片轉為較小子階段，並把 beta bootstrap 放在最前面
- `plans/20260401_provider-list-commit/implementation-spec.md`
  - 已加入 Claude Native oversized-slice replan 與新的 phase ordering
- `plans/20260401_provider-list-commit/handoff.md`
  - build entry 已改成先做 beta authority / worktree bootstrap
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 execution-plan refinement）

## 2026-04-01 Claude Native beta bootstrap + source scaffold

### 需求

- 依 `plans/20260401_provider-list-commit` 的新順序，先完成 beta bootstrap，再只做 `packages/opencode-claude-provider` 的最小 source scaffold slice。
- 不跳過 disposable beta surface，不直接在 authoritative `recovery` worktree 寫 Claude Native code。

### 範圍

IN:

- `/home/pkcs12/projects/opencode`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit`
- `plans/20260401_provider-list-commit/tasks.md`
- `packages/opencode-claude-provider/**`
- `docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不處理 `4.x` auth bridge / loader wiring
- 不處理 `5.x` Claude Native activation
- 不 commit / push / finalize / cleanup beta surface

### 任務清單

- [x] Restate and verify beta authority tuple
- [x] 建立新的 disposable `beta/provider-list-commit` branch 與 worktree
- [x] 在 beta surface 重建最小 `packages/opencode-claude-provider` source scaffold
- [x] 執行 bounded scaffold validation
- [x] 同步 event / architecture sync 記錄

### Debug Checkpoints

#### Baseline

- `plans/20260401_provider-list-commit` 已把 Claude Native 第一個過大 slice 改寫為 beta bootstrap -> scaffold -> bridge/wiring -> activation。
- admission 檢查先前確認 mainline authority 已明確，但 implementation surface 尚未建立，不能直接進入 code-bearing slice。

#### Execution

- authority tuple 已明確落地為：
  - `mainRepo`: `/home/pkcs12/projects/opencode`
  - `mainWorktree`: `/home/pkcs12/projects/opencode`
  - `baseBranch`: `recovery/cms-codex-20260401-183212`
  - `implementationRepo`: `/home/pkcs12/projects/opencode`
  - `implementationWorktree`: `/home/pkcs12/projects/opencode-worktrees/provider-list-commit`
  - `implementationBranch`: `beta/provider-list-commit`
  - `docsWriteRepo`: `/home/pkcs12/projects/opencode`
- 已建立新的 disposable beta surface：
  - `git worktree add -b "beta/provider-list-commit" "/home/pkcs12/projects/opencode-worktrees/provider-list-commit" "recovery/cms-codex-20260401-183212"`
- 已確認 beta branch 從正確 base 開出，未重用既有 stale `beta/*` / `test/*` / `feature/*` surfaces。
- 在 beta worktree 新增最小 `packages/opencode-claude-provider` scaffold，包含：
  - `CMakeLists.txt`
  - `include/claude_provider.h`
  - `src/{provider,main,originator,auth,storage,stream,transform,transport}.c`
  - `.gitignore`

#### Root Cause

- 本 slice 的真正 blocker 不是單一缺檔，而是先前缺少 admitted implementation surface，導致 beta-workflow 無法合法進入 code-bearing 狀態。
- 一旦先完成 authority restatement + disposable beta bootstrap，最小 scaffold 可在不碰 authoritative recovery worktree 的前提下獨立回補並驗證。

#### Validation

- Bootstrap:
  - `git -C /home/pkcs12/projects/opencode-worktrees/provider-list-commit status --short --branch` -> `beta/provider-list-commit`
  - `git -C /home/pkcs12/projects/opencode-worktrees/provider-list-commit merge-base --is-ancestor recovery/cms-codex-20260401-183212 HEAD` ✅
- Scaffold build:
  - `cmake -S /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider -B /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider/build` ✅
  - `cmake --build /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider/build` ✅
  - `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider/build/claude-provider --version` -> `0.1.0`
  - `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider/build/claude-provider` -> `{"type":"ready","abi":1,"originator":"claude-provider/0.1.0"}`
- Remaining gap:
  - auth bridge / loader wiring / activation 仍待 `4.x`、`5.x`
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次新增的是 beta execution evidence 與最小 scaffold，未改變長期模組邊界或資料流）

## 2026-04-01 Claude Native auth bridge + loader wiring

### 需求

- 在已建立的 `beta/provider-list-commit` surface 上補回最小 `claude-native` auth bridge 與 loader init 路徑。
- 保持目前 `AnthropicAuthPlugin` request/fetch path，不重啟 DD-9 full native transport。

### 範圍

IN:

- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider/include/claude_provider.h`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider/src/{auth,storage,provider}.c`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/plugin/claude-native.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/plugin/index.ts`
- `/home/pkcs12/projects/opencode/docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不重啟 DD-9 `provider.ts` native transport 切換
- 不實作 native login/refresh/logout 完整生命週期
- 不進入 `5.x` activation

### 任務清單

- [x] 重建 historical auth/storage bridge 證據
- [x] 補回最小 native auth setter/status ABI
- [x] 補回 `claude-native` plugin wrapper 並掛回 plugin registry
- [x] 執行 targeted build / smoke validation
- [x] 同步 event / architecture sync 記錄

### Debug Checkpoints

#### Baseline

- `197fc2bd7` 的 `claude-provider` 使用獨立 `~/.claude-provider/auth.json` 儲存 auth state，而非直接共用 `accounts.json`。
- `9321ca7b1` 的 `claude-native` plugin 採 native-auth-only bridge，實際 request path 仍沿用 `AnthropicAuthPlugin`。
- `4a4c69488` 明確指出 DD-9 被擱置的主因之一就是缺少 `accounts.json` ↔ native auth 的 bridge/setter API。

#### Execution

- 已在 native scaffold 補上 bridge-capable ABI：
  - `claude_set_oauth_tokens(...)`
  - `claude_set_api_key(...)`
  - `claude_get_auth_status(...)`
- native bridge 寫入 `~/.claude-provider/auth.json`，並支援 `CLAUDE_PROVIDER_HOME` override。
- 已新增 `packages/opencode/src/plugin/claude-native.ts`：
  - 以既有 `AnthropicAuthPlugin` 為 base
  - loader 階段先做 native init + auth seed + status readback
  - request transport 仍維持既有 fetch path
- `packages/opencode/src/plugin/index.ts` 已將 `claude-cli` internal plugin 接回 `ClaudeNativeAuthPlugin`。
- 本 slice 未修改 `packages/opencode/src/provider/provider.ts`。

#### Root Cause

- 先前 Claude Native 無法安全恢復，不是因為 native binary 不存在，而是缺少一條最小可觀測的 auth bridge，使 TS/runtime 無法把現有 `accounts.json` auth 狀態 seed 進 native sidecar。
- 只要把 scope 限縮為「native auth seed + loader init」，就能在不重啟高風險 transport 改寫的前提下恢復最小 Claude Native path。

#### Validation

- Native build:
  - `cmake -S /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider -B /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider/build` ✅
  - `cmake --build /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider/build` ✅
  - `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider/build/claude-provider` -> `{"type":"ready","abi":1,"originator":"claude-provider/0.1.0"}` ✅
- Loader/auth bridge smoke:
  - 以 mock OAuth auth 執行 `bun -e 'import(.../plugin/claude-native.ts)...'` -> `{"hasFetch":true,"hasApiKey":true,"isClaudeCode":true}` ✅
  - bridge output file `/tmp/claude-provider-smoke/auth.json` 已驗證為 oauth shape ✅
- Hygiene:
  - `git diff --check` ✅
- TypeScript:
  - `bun x tsc -p /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/tsconfig.json --noEmit` ❌
  - 阻塞來自 beta worktree dependency/tsconfig baseline（`@tsconfig/bun/tsconfig.json` 缺失與既有解析錯誤），非本 slice 單點回歸
- Remaining gap:
  - native refresh/login/logout API 與完整 activation/runtime path 仍待 `5.x`
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為最小 auth bridge / loader wiring 回補，未改變長期模組邊界或資料流）

## 2026-04-01 Claude Native minimum activation validation

### 需求

- 驗證目前 beta surface 上的 `claude-native` wiring 是否已構成最小可行 activation。
- 判定剩餘 Claude Native backlog 是否可明確 deferred，而不再阻擋後續 runtime/provider slices。

### 範圍

IN:

- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/plugin/{index.ts,claude-native.ts,anthropic.ts}`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/provider/provider.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode-claude-provider/build/*`
- `/home/pkcs12/projects/opencode/docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不重啟 full native transport
- 不擴大到 native refresh/login/logout lifecycle
- 不做 fetch-back/finalize/cleanup

### 任務清單

- [x] 驗證 `claude-cli` 選到 `ClaudeNativeAuthPlugin`
- [x] 驗證 loader 會 seed native auth 並保留 `hasFetch` / `isClaudeCode`
- [x] 驗證 request path 仍維持 `AnthropicAuthPlugin` fetch path
- [x] 判定剩餘 Claude Native backlog 可 deferred
- [x] 同步 event / architecture sync 記錄

### Debug Checkpoints

#### Baseline

- `5.1` analysis 已確認目前窄定義 activation 不需要重新打開 DD-9 `provider.ts` native transport。
- 既有 `4.x` wiring 已經把最小 activation 所需的 native init/auth bridge 接上，因此本輪重點是 focused validation，而不是再做大改。

#### Execution

- `claude-cli` 目前由 `packages/opencode/src/plugin/index.ts` 映射到 `ClaudeNativeAuthPlugin`。
- `packages/opencode/src/plugin/claude-native.ts` 以 `AnthropicAuthPlugin` 為 base，loader 階段負責 native init、auth seed、status readback，實際 fetch 路徑仍交還 TS plugin。
- focused smoke 保留 `/tmp/claude-provider-smoke-final/auth.json` 作為 native auth shape 證據。

#### Root Cause

- 先前 Claude Native 是否「已啟用」不清楚，核心不是缺少更多程式碼，而是缺少對目前窄 activation 定義的直接證據。
- 一旦證明 provider/plugin selection、native auth seed、以及 fetch-path 保留都成立，就可把剩餘未恢復部分明確降級為 deferred backlog，而不是持續阻塞整體 recovery。

#### Validation

- Admission:
  - `git status --short --branch` in `/home/pkcs12/projects/opencode-worktrees/provider-list-commit` -> `## beta/provider-list-commit`
  - `git merge-base --is-ancestor recovery/cms-codex-20260401-183212 HEAD && git rev-parse --abbrev-ref HEAD` -> `beta/provider-list-commit`
- Plugin/provider selection proof:
  - `rg -n "claude-cli|ClaudeNativeAuthPlugin|AnthropicAuthPlugin" /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/plugin/index.ts /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/plugin/claude-native.ts /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/plugin/anthropic.ts /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/provider/provider.ts`
  - 證明：
    - `plugin/index.ts:31` -> `{ name: "claude-cli", plugin: ClaudeNativeAuthPlugin }`
    - `claude-native.ts:169` -> `const baseHooks = await AnthropicAuthPlugin(input)`
    - `provider.ts:1570-1665` 存在 plugin auth loader 對 family/account providers 的套用路徑
- Loader/fetch smoke:
  - `CLAUDE_PROVIDER_HOME="/tmp/claude-provider-smoke-final" bun -e 'import(".../claude-native.ts") ... await hooks.auth.loader(...)'` -> `{"hasFetch":true,"isClaudeCode":true}`
  - 讀 `/tmp/claude-provider-smoke-final/auth.json` -> oauth shape：`type/refresh/access/expires/email/orgID`
  - `tmpdir="/tmp/claude-provider-smoke-$$" ... await options.fetch("/v1/messages", ...)` ->
    - `hasFetch: true`
    - `hasApiKey: true`
    - `isClaudeCode: true`
    - request URL `https://api.anthropic.com/v1/messages?beta=true`
    - headers 帶 `authorization: Bearer access-token`、`user-agent: claude-code/2.1.39`
    - body 含 Claude Code system prompt
  - 上述證明實際 request path 仍由 `packages/opencode/src/plugin/anthropic.ts` 處理
- Hygiene:
  - `git diff --check` ✅
- Backlog decision:
  - 可安全 deferred：native refresh/login/logout lifecycle、native↔`accounts.json` two-way sync、DD-9/full native transport revival
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 focused activation evidence 與 backlog defer decision，未改變長期架構邊界或資料流）

## 2026-04-01 runtime/context hardening — lazy tool loading / adaptive auto-load

### 需求

- 先從 `6.x` 中最集中的子系統切片開始，恢復 lazy tool loading / adaptive auto-load 與其 correctness fixes。
- 不混入 `6.2b` small-context compaction truncation 與 `6.2c` toolcall schema/error-recovery guidance。

### 範圍

IN:

- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/session/resolve-tools.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/session/tool-invoker.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/config/config.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/tool/registry.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/tool/tool-loader.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/session/unlocked-tools.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/tool/frequency.ts`

OUT:

- 不修改 `compaction.ts`
- 不修改 `apply_patch.txt` / `edit.txt`
- 不擴大成 broader runtime sweep

### 任務清單

- [x] 恢復 lazy tool loading / adaptive auto-load 最小路徑
- [x] 補回 follow-up correctness fixes
- [x] 執行 focused smoke validation
- [x] 同步 event / plan state

### Debug Checkpoints

#### Baseline

- `6.1` reconstruction 顯示目前 `beta/provider-list-commit` 還缺 `tool_loader`、unlocked-tools、frequency heat-score 與 `resolveTools(...)` 的 lazy filter/unlock 路徑。
- follow-up commits `43d2ca35c` / `a34d8027a` 直接修正初版 loader correctness，因此此輪必須一起帶回。

#### Execution

- 已新增 session-scoped unlock state、tool frequency storage、`tool_loader`，並更新 `resolveTools(...)` / `registry.ts` / `config.ts`。
- `tool-invoker.ts` 也一併更新，以便 adaptive auto-load 真正記錄 `ToolFrequency.record(...)`。
- correctness fixes 已包含：
  - always-present IDs 使用 `todowrite` / `todoread`
  - `tool_loader` description 採 in-place mutation，不重建 execute/schema

#### Validation

- Focused Bun smoke:
  - `round1` -> `["question","read","todoread","todowrite","tool_loader"]`
  - `round2` -> `["bash","question","read","todoread","todowrite","tool_loader"]`
  - `hasCatalogBash: true`
  - `hasCatalogEdit: true`
  - `hasInputSchema: true`
  - `hasBashAfterUnlock: true`
  - `hasEditAfterUnlock: false`
- 上述證明：
  - always-present tools 先被保留
  - lazy tools 初輪被過濾
  - `tool_loader` 暴露 catalog description
  - unlock 影響下一輪 resolution
  - schema/execute surface 未被 description mutation 破壞
- Hygiene:
  - `git diff --check` ✅
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 lazy tool loading/runtime resolution hardening 回補，未改變長期架構邊界）

## 2026-04-01 runtime/context hardening — small-context compaction truncation

### 需求

- 恢復 small-context model 的 compaction truncation safeguards，避免 compaction history 在小上下文模型上先天溢出。
- 不混入 lazy tool loading 或 toolcall schema/error-recovery guidance。

### 範圍

IN:

- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/session/compaction.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/session/compaction.test.ts`

OUT:

- 不修改 loader/tool registry 路徑
- 不修改 `apply_patch.txt` / `edit.txt`
- 不做 broader compaction redesign

### 任務清單

- [x] 恢復 small-context truncation safeguards
- [x] 新增 focused test 驗證 safe budget 截斷
- [x] 執行 focused validation
- [x] 同步 event / plan state

### Debug Checkpoints

#### Baseline

- 歷史證據 `4a6e10f99` 顯示小上下文模型需要先對 compaction history 做安全截斷，再送入 compaction prompt。
- 目前 beta tree 的 `compaction.ts` 尚未包含這條 small-context 保護邏輯。

#### Execution

- `SessionCompaction.process(...)` 現在會先使用 small-context safe budget 截斷後的 history。
- 新增 `truncateModelMessagesForSmallContext(...)` 與對應 small-context budget 常數。
- `compaction.test.ts` 新增 focused truncation test。

#### Validation

- Historical evidence:
  - `git show --stat --oneline 4a6e10f99`
  - `git diff 4a6e10f99^ 4a6e10f99 -- packages/opencode/src/session/compaction.ts`
- Focused test:
  - `bun test /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/session/compaction.test.ts`
  - 初次失敗因 beta worktree 無 `node_modules` 解析
  - 以臨時 symlink 指向 authoritative repo `node_modules` 後重跑 -> `3 pass, 0 fail`
- Hygiene:
  - `git diff --check` ✅
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 compaction small-context 保護邏輯回補，未改變長期架構邊界）

## 2026-04-01 runtime/context hardening — toolcall schema / error-recovery guidance

### 需求

- 補回 `apply_patch` / `edit` tool prompt 中的 schema guidance 與 failure-recovery examples。
- 保持與目前 repo 的 read-first 規則一致，不重寫其他 runtime 行為。

### 範圍

IN:

- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/tool/apply_patch.txt`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/tool/edit.txt`

OUT:

- 不修改 lazy tool loading
- 不修改 compaction
- 不擴大到 broader prompt/runtime behavior

### 任務清單

- [x] 補回 `apply_patch.txt` 的 patch-context / exact-match / indentation / recovery guidance
- [x] 補回 `edit.txt` 的 exact-spacing examples 與 not-found / multiple-matches recovery guidance
- [x] 執行 focused validation
- [x] 同步 event / plan state

### Debug Checkpoints

#### Baseline

- 歷史證據 `eaced345d` 顯示這一輪是 prompt-guidance hardening，而不是 runtime logic 變更。
- 目標是把 toolcall schema/error-recovery 指引補齊，同時不違反目前 repo 已加入的 read-first 規則。

#### Execution

- `apply_patch.txt` 補回 patch-context / exact-match / indentation / failure-recovery 指引。
- `edit.txt` 補回 exact-spacing 範例與 `oldString` not found / multiple matches recovery 指引。
- 內容保持與目前 repo 的 read-first 規則相容。

#### Validation

- Historical evidence:
  - `git show --stat --oneline eaced345d`
  - `git diff eaced345d^ eaced345d -- packages/opencode/src/tool/apply_patch.txt packages/opencode/src/tool/edit.txt`
- Current result:
  - `git diff -- packages/opencode/src/tool/apply_patch.txt packages/opencode/src/tool/edit.txt`
  - 證明更新後文字包含目標 schema/error-recovery guidance
- Hygiene:
  - `git diff --check` ✅
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 prompt-guidance hardening，未改變長期架構邊界）

## 2026-04-02 session hardening — rebind checkpoint durability + safe injection

### 需求

- 補上 rebind checkpoint 的 durability metadata 與 safe checkpoint injection，避免 restart/rebind 從 dangling tool-result 邊界直接續跑。
- 不擴大到 `llm.ts`、`codex-websocket.ts`、`workflow-runner.ts` 或 task-worker continuation。

### 範圍

IN:

- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/session/compaction.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/session/prompt.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/session/compaction.test.ts`

OUT:

- 不修改 `llm.ts`
- 不修改 `codex-websocket.ts`
- 不修改 `workflow-runner.ts`
- 不重寫 broader replay/continuation stack

### 任務清單

- [x] 讓 rebind checkpoint 持久化 `snapshot + lastMessageId + timestamp`
- [x] 補上 `deleteRebindCheckpoint(...)` 與 `pruneStaleCheckpoints(...)`
- [x] 補上 safe checkpoint injection / boundary validation
- [x] 執行 focused validation 並判定 `7.2b` 是否還需要

### Debug Checkpoints

#### Baseline

- `7.1` reconstruction 顯示目前真正還缺的 session-hardening 核心缺口，是 `compaction.ts` / `prompt.ts` 上的 checkpoint durability 與 boundary-safe injection，而不是整包 continuation stack。
- 其餘候選像 `llm.ts`、`codex-websocket.ts`、`task-worker-continuation.ts` 的主要保護大多已存在於 current tree。

#### Execution

- rebind checkpoint 現在持久化 `snapshot + lastMessageId + timestamp`。
- 已補上 `deleteRebindCheckpoint(...)` 與 `pruneStaleCheckpoints(...)`。
- startup/rebind path 會先嘗試 safe checkpoint injection，避免從 dangling tool-result 邊界繼續。
- continuation invalidation fallback 也改為讀 checkpoint 結構而非裸字串。

#### Validation

- Historical evidence:
  - `git show --stat --oneline 3fd1ef9b8`
  - `git diff 3fd1ef9b8^ 3fd1ef9b8 -- packages/opencode/src/session/compaction.ts packages/opencode/src/session/prompt.ts packages/opencode/src/session/message-v2.ts`
- Focused tests:
  - `bun test /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/opencode/src/session/compaction.test.ts` -> `6 pass, 0 fail`
  - 覆蓋：safe rebind checkpoint injection、persisted checkpoint metadata（含 `lastMessageId`）、stale checkpoint prune、既有 compaction guards
  - beta worktree 仍需臨時 `node_modules` symlink 才能執行 focused test
- Hygiene:
  - `git diff --check` ✅
- Decision:
  - `7.2b` 目前無新增 proven gap，保持 evidence-driven deferred
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 session checkpoint durability/injection hardening，未改變長期架構邊界）

## 2026-04-02 plan refinement — provider-manager closure gate

### 需求

- 在 plan mode 對齊 `8.x` 收尾策略，避免 tasks/runtime 實際狀態與 planner artifacts 分裂。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/plans/20260401_provider-list-commit/tasks.md`
- `/home/pkcs12/projects/opencode/plans/20260401_provider-list-commit/handoff.md`
- `/home/pkcs12/projects/opencode/plans/20260401_provider-list-commit/implementation-spec.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不執行 build-mode 程式碼修改
- 不啟動 fetch-back/finalize/cleanup

### 決策

- `8.2a` 視為已完成並在 `tasks.md` 勾選完成。
- `8.2b` 預設改為 deferred（`[~]`），僅在出現新的 dialog reopen geometry 缺陷證據時重開。
- `8.3` validation 先採 Focused 最小集（provider visibility/favorites + model-selector state 行為），不先擴大到 e2e。

### Validation

- Planner artifact sync:
  - `tasks.md`：`8.2a -> [x]`、`8.2b -> [~] deferred`、`8.3` 保持待執行
  - `handoff.md`：build entry 改為先執行 `8.3`
  - `implementation-spec.md`：Validation 區段 build entry 已對齊 `8.3` + `8.2b deferred`
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 planning artifact 對齊與決策收斂）

## 2026-04-02 plan completion — post-8.3 closure path

### 需求

- 把 `8.3` 之後的收尾流程寫完整，避免誤把 `8.3` 當成整個 recovery workstream 的最後一步。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/plans/20260401_provider-list-commit/tasks.md`
- `/home/pkcs12/projects/opencode/plans/20260401_provider-list-commit/implementation-spec.md`
- `/home/pkcs12/projects/opencode/plans/20260401_provider-list-commit/handoff.md`
- `/home/pkcs12/projects/opencode/plans/20260401_provider-list-commit/spec.md`

OUT:

- 不執行 build-mode 程式碼驗證
- 不提前啟動 fetch-back/finalize/cleanup

### 決策

- `8.3` 定位為最後一個 provider-manager focused validation slice，但不是整體 workflow 終點。
- `9.2` / `9.3` 明確保留為 retrospective closure 必做項。
- 新增 `10.x Finalize Gate`，把 fetch-back / finalize / cleanup 改成 approval-required completion path。

### Validation

- `tasks.md`
  - 已新增 `10.1` / `10.2` / `10.3` finalize gate tasks
- `implementation-spec.md`
  - Structured Execution Phases 已明確拆成 `Phase 8` validation、`Phase 9` retrospective、`Phase 10` approval-gated finalize
- `handoff.md`
  - 已明示 `8.3` 後仍須完成 `9.2` / `9.3`，再進 `10.1`
- `spec.md`
  - 已新增 finalize approval-gate requirement 與 acceptance check
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 planner closure path 明文化）

## 2026-04-02 provider-manager 8.3 validation + closure review

### 需求

- 依 beta workflow 完成 `8.3` focused validation，並基於結果完成 `9.2`、`9.3`、`10.1` 的 closure review。

### 範圍

IN:

- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/src/components/dialog-select-model.tsx`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/src/components/model-selector-state.test.ts`
- `/home/pkcs12/projects/opencode/plans/20260401_provider-list-commit/tasks.md`
- `/home/pkcs12/projects/opencode/plans/20260401_provider-list-commit/proposal.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不啟動 fetch-back/finalize/cleanup
- 不在本輪新增 8.2b geometry cleanup 或其他 code fix

### Debug Checkpoints

#### Baseline

- `8.2a` 已完成實作；本輪只做 focused evidence collection，不再混入新功能修改。
- `8.2b` 仍維持 evidence-driven deferred，除非 validation 顯示 reopen geometry 缺陷。

#### Execution

- beta authority tuple 已再次確認：
  - `mainRepo`: `/home/pkcs12/projects/opencode`
  - `mainWorktree`: `/home/pkcs12/projects/opencode`
  - `baseBranch`: `recovery/cms-codex-20260401-183212`
  - `implementationRepo`: `/home/pkcs12/projects/opencode`
  - `implementationWorktree`: `/home/pkcs12/projects/opencode-worktrees/provider-list-commit`
  - `implementationBranch`: `beta/provider-list-commit`
  - `docsWriteRepo`: `/home/pkcs12/projects/opencode`
- admission 檢查顯示 beta branch 相對當前 base branch 落後，但差異僅限 docs/plans：
  - `docs/events/event_20260401_cms_codex_recovery.md`
  - `plans/20260401_provider-list-commit/{design,handoff,implementation-spec,proposal,spec,tasks}.md`
- 執行 focused validation：
  - `bun test /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/src/components/model-selector-state.test.ts`
  - `bun x tsc -p /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/tsconfig.json --noEmit`
  - 補以 target diff/source evidence 檢查 `dialog-select-model.tsx`

#### Validation

- Focused test:
  - `13 pass, 0 fail`
- Focused source evidence:
  - hidden-provider state 為 localStorage-backed：
    - `packages/app/src/components/dialog-select-model.tsx:66`
    - `packages/app/src/components/dialog-select-model.tsx:72-80`
    - `packages/app/src/components/dialog-select-model.tsx:1101-1102`
  - favorites filtering 採 `provider.accounts > 0`：
    - `packages/app/src/components/dialog-select-model.tsx:1158-1162`
  - provider-level global disable toggle 已不在 target diff：
    - 移除 `toggleProviderEnabled(...)`
    - 移除 `globalSync.configActions.setDisabledProviders(...)`
  - `8.2b` 未被意外混入：目前 diff 侷限在 hidden-state/filtering/既有排版附近，未新增 reopen geometry logic
- App typecheck:
  - `bun x tsc -p /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/tsconfig.json --noEmit` ❌
  - 原因包含 repo/beta baseline 缺依賴，以及 target file 現有 TS errors（含 import-resolution 與 `dialog-select-model.tsx` 型別錯誤）
- Coverage gap:
  - `model-selector-state.test.ts` 通過，但未直接執行 localStorage hidden-provider path；該部分目前由 source evidence 補強
- Requirement coverage (`9.2`):
  - Effective requirement #1/#2/#3/#4/#5/#6 均已被本 recovery plan 與已完成 slices 實質覆蓋
  - 但 `8.2a` 的最終 ship/readiness 證據仍不完整，因 app typecheck 未綠且 hidden-provider path 缺少直接執行型測試
- Validation checklist (`9.3`):
  - Restored: provider visibility localStorage semantics, favorites by connected accounts, no provider-level disabled toggle path
  - Deferred: `8.2b` dialog reopen geometry cleanup, Claude Native lifecycle/full transport backlog, `7.2b` continuation leftovers
  - Evidence: focused test pass, source-line proof, beta admission proof, app typecheck failure evidence
- Finalize recommendation (`10.1`):
  - **Do not fetch-back/finalize yet**
  - 先處理 decision gate：是否接受目前 focused evidence 作為 sufficient closure，或新增 remediation slice 解 target TS errors / direct hidden-provider execution coverage
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 validation/closure review，未改變長期架構邊界）

## 2026-04-02 provider-manager remediation replan

### 需求

- 使用者在 `10.2` decision gate 選擇 remediation，而不是接受目前證據直接進 finalize。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/plans/20260401_provider-list-commit/{tasks,implementation-spec,handoff,spec,proposal,design}.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不直接 fetch-back/finalize/cleanup
- 不重開 `8.2b` dialog geometry cleanup

### 決策

- 在同一個 `provider-list-commit` plan root 新增 bounded remediation slice：
  - `8.4a` target `dialog-select-model.tsx` readiness/type issues
  - `8.4b` direct hidden-provider execution coverage
  - `8.5` focused re-validation
- `9.2` / `9.3` / `10.1` 重新回到 pending，等待 remediation 後的新證據。

### Validation

- Planner artifacts updated:
  - `tasks.md` 已新增 `8.4a` / `8.4b` / `8.5`
  - `implementation-spec.md` 已新增 remediation phase 並把 build entry 改到 `8.4a`
  - `handoff.md` 已明示 `8.3` 證據不足與 remediation-approved state
  - `spec.md` 已新增 insufficient-evidence -> remediation requirement
  - `proposal.md` / `design.md` 已同步這次 decision 與風險收斂
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 remediation replan，未改變長期架構邊界）

## 2026-04-02 provider-manager remediation — 8.4b direct hidden-provider coverage

### 需求

- 補上 hidden-provider localStorage path 的直接執行覆蓋，避免 `8.3` 只剩 source evidence 而沒有直接測試證據。

### 範圍

IN:

- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/src/components/model-selector-state.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/src/components/dialog-select-model.tsx`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/src/components/model-selector-state.test.ts`

OUT:

- 不處理 `8.2b` geometry cleanup
- 不擴大到 unrelated app baseline dependency failures

### Execution

- 在 `model-selector-state.ts` 抽出共用 helper：
  - `parseHiddenProvidersStorageValue(...)`
  - `loadHiddenProvidersFromStorage(...)`
- `dialog-select-model.tsx` 改為沿用該 helper，維持原本 localStorage 語義。
- `model-selector-state.test.ts` 新增：
  - localStorage-backed hidden-provider 讀取測試
  - malformed persisted value 容錯測試

### Validation

- Focused test:
  - `bun test /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/src/components/model-selector-state.test.ts`
  - `15 pass, 0 fail`
- Direct coverage:
  - hidden-provider localStorage path 現在透過 `loadHiddenProvidersFromStorage(...)` 被直接執行
- Hygiene:
  - `git diff --check -- packages/app/src/components/dialog-select-model.tsx packages/app/src/components/model-selector-state.ts packages/app/src/components/model-selector-state.test.ts` ✅
- Issues retained:
  - app baseline import-resolution diagnostics 仍存在，但本次未擴大處理
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 direct test coverage 補強，未改變長期架構邊界）

## 2026-04-02 provider-manager remediation — 8.5 focused re-validation + closure review

### 需求

- 在 `8.4a` / `8.4b` 後重跑 focused validation，並完成 `9.2`、`9.3`、`10.1` 的 closure 判讀。

### 範圍

IN:

- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/src/components/dialog-select-model.tsx`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/src/components/model-selector-state.ts`
- `/home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/src/components/model-selector-state.test.ts`
- `/home/pkcs12/projects/opencode/plans/20260401_provider-list-commit/proposal.md`

OUT:

- 不 reopen `8.2b` geometry cleanup
- 不處理 baseline app dependency resolution 問題
- 不直接 fetch-back/finalize/cleanup

### Validation

- Focused tests:
  - `bun test /home/pkcs12/projects/opencode-worktrees/provider-list-commit/packages/app/src/components/model-selector-state.test.ts`
  - `15 pass, 0 fail`
- TypeScript:
  - app-wide `tsc --noEmit` 仍失敗
  - 針對 `dialog-select-model.tsx` / `model-selector-state` 的 filtered diagnostics 只剩 baseline TS2307 import-resolution failures
  - 先前 target-file TS2339 / TS7006 errors 未再出現
- Focused evidence:
  - hidden-provider localStorage path 仍為 localStorage-backed：`dialog-select-model.tsx:73-76`
  - direct helper coverage：`model-selector-state.ts:81-94`
  - direct test coverage：`model-selector-state.test.ts:182-199`
  - favorites semantics 仍依 `provider.accounts > 0`：`dialog-select-model.tsx:1153-1157`
  - `8.2b` 未被擴大：diff 僅涉及 storage helper usage、typing、focused test support
- Requirement coverage (`9.2`):
  - Proposal effective requirement #1-#7 均已符合：本 recovery slice 已完成 inventory-based, evidence-backed, slice-by-slice restoration，並在 validation 證據不足時完成 bounded remediation
- Validation checklist (`9.3`):
  - Restored/validated: hidden-provider localStorage semantics, direct execution coverage, favorites-by-accounts semantics, no provider-level disabled toggle path
  - Deferred: `8.2b` geometry cleanup, `7.2b`, Claude Native lifecycle/full transport backlog
  - Remaining blocker: app-wide ship gate 若要求整體 app typecheck green，仍被 baseline dependency resolution failures 阻擋
- Finalize recommendation (`10.1`):
  - **可以 finalize 這個 recovery slice，前提是你接受 baseline app dependency failures 不屬於本 slice 收尾範圍**
  - **若你的 finalize 標準要求 app-wide typecheck green，則不應 finalize，應另開 baseline remediation workstream**
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 focused re-validation 與 closure review，未改變長期架構邊界）
