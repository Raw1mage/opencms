# 2026-04-18 — Codex C library removal + subagent rotation RCA instrumentation

## Context

使用者 2026-04-18 晚間回報 subagent session 打 `codex/gpt-5.4 (raw@sob.com.tw)` 命中 429 / QUOTA_EXHAUSTED 時 rotation3d 似乎沒能在第一時間接手，並伴隨兩次相同 request ID 的「Codex WS: An error occurred…」錯誤訊息。

## 工作摘要

合併在單一 beta 分支 `beta/codex-cleanup-rotation-rca`：

### 1. 死碼清除（Track A）

刪除 `packages/opencode-codex-provider/` 下所有 C 實作與 build 系統，理由：整套從未被 TS 端載入（無 `codex-native.ts`、無 `dlopen("codex_provider.so")`），保留只會讓未來 RCA 誤判。

已 `git rm`：

- `src/auth.c` / `src/jwt.c` / `src/main.c` / `src/originator.c` / `src/provider.c`
- `src/quota.c` / `src/storage.c` / `src/stream.c` / `src/transform.c` / `src/transport.c`
- `include/codex_provider.h`
- `CMakeLists.txt`
- `.gitignore`（僅 ignore 已刪除的 `build/`，留白無意義）

`rm -rf`：

- `build/`（untracked artifact）
- `include/`（空目錄）

### 2. Rotation escalation instrumentation（Track B Phase A）

在 rate-limit escalation chain 5 個節點加 `[rot-rca]` 前綴 log：

| 節點 | 檔案 | 訊號 |
|---|---|---|
| Child publish-done | `packages/opencode/src/session/processor.ts` | `publishElapsedMs` |
| Child wait-resolved / timeout | `packages/opencode/src/session/processor.ts` | `waitElapsedMs`、`totalElapsedMs` |
| Parent recv | `packages/opencode/src/tool/task.ts` | `accountIdTail`、`triedCount` |
| Parent fallback-done | `packages/opencode/src/tool/task.ts` | `foundFallback`、`fallbackElapsedMs` |
| Parent stdin-send | `packages/opencode/src/tool/task.ts` | `stdinWriteMs`、`totalElapsedMs` |
| Worker stdin-recv | `packages/opencode/src/cli/cmd/session.ts` | `resolved`、偵測 RW-1 drop |
| Signal wait-register / overwrite / timeout / resolve-miss | `packages/opencode/src/session/model-update-signal.ts` | 偵測 RW-1 與量測 wait 實際時長 |

這些是診斷用 log，用來驗證 5 個 RCA 候選（H1..H5）中哪些是真正原因。完成 RCA 後精簡成穩定 log subset。

## 根因診斷心得（暫定）

Explore agent 與人工 code review 指出：

- **H1 — no fallback**（最可能）：所有 codex 帳號同時 rate-limit 時，parent 的 `handleRateLimitFallback` 刻意不回覆（Fix B1 設計），child `ModelUpdateSignal.wait` 30s timeout。使用者感受：卡 30 秒後錯誤。
- **H4 — UI 雙渲染**（可能並存）：同 request ID 出現兩次應為 TUI reducer 重覆處理單一 error event，非真實雙發請求。
- **H2/H3/H5** 不排除，由 Phase A log 數據驗證。

待 Phase A log 收集後於 `specs/codex/revision/2026-04-18_subagent-rotation-rca/design.md` 補 `## RCA Findings` 段落並選定 fix。

## 學到的教訓

**「有看起來可疑的 retry loop」≠「該 loop 在線上被執行」。** 每個可疑 code 路徑都必須確認有消費者才開 fix plan。此次因為沒先確認就寫 fix plan，浪費半天工時。新 plan-builder 流程應把「verify consumer exists」列為 pre-check。

## 相關 spec

- `specs/codex/revision/2026-04-18_codex-c-library-removal/`
- `specs/codex/revision/2026-04-18_subagent-rotation-rca/`
- `specs/codex/provider_runtime/design.md#DD-6`（新增交叉參考）
