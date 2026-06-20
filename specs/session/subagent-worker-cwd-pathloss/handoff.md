# Handoff: subagent_cwd_pathloss_hang

## Execution Contract

本 spec 的程式碼修復已全數完成並 runtime 驗證通過（commit `0c636aa3f`）。本 handoff 記錄執行面契約，供未來 amend/extend 時參考。

## Required Reads

- `packages/opencode/src/tool/task.ts` — spawnWorker (835)、Bun.spawn cwd (842)、proc-watchdog (2158+)
- `packages/opencode/src/session/preloaded-context.ts` — getPreloadParts working-directory 注入
- `packages/opencode/src/session/prompt.ts` — paralysis detector + wiring + nudge
- `packages/opencode/src/cli/cmd/session.ts` — worker bootstrap(process.cwd())

## Stop Gates In Force

- `Instance.directory` undefined → fail loud（禁止 silent fallback，AGENTS rule 11）
- driver prompt 改動 → 必須同步 `templates/**` 鏡像
- 新增 paralysis detector 路徑 → 不得改寫既有 Detector A–D 判定條件

## Execution-Ready Checklist

- [x] Fix A：spawnWorker cwd=capturedDirectory + fail loud
- [x] Fix B：getPreloadParts 注入絕對 working-directory 錨點
- [x] Fix C：watchdog no-progress reap + paralysis detector + nudge
- [x] 單元測試 + 既有 paralysis 測試回歸 pass
- [x] runtime 驗證（live coding subagent ses_11fc0f348ffe4PRdQRgMR2d7Sp）

## Validation Evidence

- daemon cwd=`/` 下 subagent `pwd` = `/home/pkcs12/projects/opencode`（repo root）
- subagent context 含 `Working directory (workspace root): /home/pkcs12/projects/opencode`
- 相對路徑 read package.json 成功
- no-progress detector 單元測試通過；watchdog reap → `no_progress_timeout`
- typecheck pass（僅 freerun-bridge.ts 既有 error，與本 fix 無關）
