# Tasks: subagent_cwd_pathloss_hang

> Canonical task source. Checkbox notation per plan-builder §16.2:
> `[ ]` pending · `[~]` in_progress · `[x]` done · `[!]` blocked · `[?]` decision · `[>]` delegated · `[-]` cancelled

## 1. Phase A — worker spawn cwd fix (RC-1, REQUIRED)

- [x] 1.1 在 `task.ts:842` 的 `Bun.spawn(buildWorkerCmd(), {...})` options 加 `cwd: capturedDirectory`（DD-1）
- [x] 1.2 `capturedDirectory`（task.ts:840）為 undefined 時 fail loud（throw clear error，禁止 silent fallback 到 `/` 或 process.cwd()）（DD-1, AGENTS rule 11）
- [x] 1.3 grep 所有 `spawnWorker` 呼叫點（task.ts:1399, 1432）確認 Instance context 在 spawn 時必存在；若有合法 undefined 路徑，改在上層補 Instance.provide（R1）
- [x] 1.4 確認 worker 端 `bootstrap(process.cwd())`（session.ts:195）在 spawn cwd 修正後自然解析到 project root（DD-2，不需 worker 端額外改動，僅驗證）

## 2. Phase B — driver prompt working-directory env block (RC-2, REQUIRED)

- [x] 2.1 定位 subagent system prompt 組裝點（main agent `<env>` block 來源），確認 `Instance.directory` 注入路徑（DD-3）
- [x] 2.2 在 subagent system prompt 注入 `<env>` working-directory / repo-root 區塊，source 自 `Instance.directory`（DD-3）
- [x] 2.3 套用至 coding/explore/review/testing 四個 driver（共用注入點優先，避免每檔重複）
- [x] 2.4 同步 `templates/**` 對應 driver prompt 鏡像（R4）

## 3. Phase C — busy-but-no-progress reaping (RC-3, RECOMMENDED, 雙層)

- [x] 3.1 確認 stdout event bridge 是否轉發足夠 tool-result 簽章資訊供 watchdog 判斷 no-progress（R2 前置檢查）
- [x] 3.2 proc-watchdog（task.ts:2158+）加 no-progress 訊號：M（≥5）次連續 tool error / identical-signature output → reap，finish=`no_progress_timeout`（DD-4）。若 3.1 資訊不足則標 `[!]` 降級依賴 3.3
- [x] 3.3 新增 paralysis detector（prompt.ts，與 detectPrefaceParalysis 並列）：≥N（≥6）輪 tool-active 但 mutatedPerTurn 全 false 且 repeated error/identical-result，與 preface 相似度無關（DD-5）
- [x] 3.4 detector wiring：接到 prompt.ts:2691 區段的 detector 判定鏈（sigTriple/narrativeTriple/prefaceTriple 旁新增一路），複用 `PARALYSIS_PROGRESS_TOOLS`（line 451）與 jaccard 工具
- [x] 3.5 為新 detector 加 nudge 文案（selectParalysisNudge, prompt.ts:467 擴充）

## 4. Phase V — validation

- [x] 4.1 Fix A 驗證：3R 後 live coding subagent 實測 `pwd`=`/home/pkcs12/projects/opencode`（repo root，非 `/`）；相對路徑 read package.json 成功 → cwd fix runtime 生效
- [x] 4.2 Fix B 驗證：live subagent 回報 context 含 `Working directory (workspace root): /home/pkcs12/projects/opencode`（`<cwd_listing>` 標頭，source 自 Instance.directory）→ preload 注入 runtime 生效
- [x] 4.3 Fix C 驗證：新 detector 單元測試（pure function，仿 detectPrefaceParalysis 測試）；watchdog 以模擬連續 error tool-result 驗 reap → `no_progress_timeout`
- [x] 4.4 回歸：既有 paralysis 測試（prompt.ts 相關）不破壞；typecheck/lint pass
- [x] 4.5 收尾：tasks.md 全勾、event_record 收尾、`specs/architecture.md` 同步檢查、關閉 BR（移至 issues/closed/）

## 5. Phase G — 畢業驗收 (graduate to spec wiki)

- [x] 5.1 補齊全套 modeling artifacts（spec/idef0/grafcet/sequence/data-schema + handoff/test-vectors/errors/observability），逐級 advance designed→planned→implementing→verified，graduate 進 /specs/
