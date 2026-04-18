# Design: codex-c-library-removal

## Context

Parent: `specs/codex/provider_runtime/` (living). 本 revision 純清理；沒有新功能、沒有協議改動。`provider_runtime/design.md` 原本並未宣告 codex 走 native FFI，因此這次刪除只是讓 runtime 實況與 spec 描述一致。

## Goals / Non-Goals

**Goals**
- 移除所有 codex C library source / header / build 定義
- `@opencode-ai/codex-provider` package 瘦身為純 TS
- 消除未來誤判死碼為活碼的誘因

**Non-Goals**
- 不動 `claude-native.ts` 與 `claude_provider.so`（claude 家族有實際 FFI 消費者）
- 不重構 TS provider 的任何公開介面
- 不修改 workspace / bun monorepo 設定

## Decisions

- **DD-1 Delete scope = C 檔 + 標頭 + build 系統.** 清單：`src/*.c`（10 檔）、`include/codex_provider.h`、`CMakeLists.txt`、`build/`。Rationale: 這組構成完整的 native lib build chain，拆開刪沒意義；一併刪除才能真正消除 dead build path。
- **DD-2 保留 `packages/opencode-codex-provider/` 目錄本身.** 因為所有 `*.ts` 檔案都活著且被 `index.ts` export。只是 package 從「C + TS 混合」變成「純 TS」。
- **DD-3 Tracked 檔案用 `git rm`，untracked 用 `rm -rf`.** Pre-check 階段 `git ls-files` 的結果：10 個 `.c`、`codex_provider.h`、`CMakeLists.txt`、`.gitignore`、`package.json`、`tsconfig.json`、所有 `.ts` 都是 tracked。`build/` 未在 `git ls-files` 出現 → untracked。所以 `git rm` + 一次 `rm -rf build/`。
- **DD-4 `.gitignore` 保留並修剪.** 內容（7 bytes）疑似就是 `build/`。修剪後若變空檔，整檔刪除；若還有其他 ignore 條目則保留修剪版。
- **DD-5 Doc 同步只補 cross-reference，不做大改.** `specs/codex/provider_runtime/design.md` 加一條 `DD-N: codex C library 於 2026-04-18 刪除（見 revision/2026-04-18_codex-c-library-removal）`。`plans/codex-refactor/plan.md` 提到 C library 的段落加「REMOVED 2026-04-18」註記，不 rewrite 整個 plan。
- **DD-6 不在 main 直接刪.** 依 AGENTS.md 與 `feedback_no_rm_tracked` 記憶，所有 `git rm` 在 `beta/codex-c-library-removal` worktree 執行，驗證後 fetch-back。

## Risks / Trade-offs

- **R-1 CI/build 隱藏依賴**：若 `.github/workflows/*` 或 `package.json` script 有呼叫 `cmake`/`make`，刪除後 CI 會紅。緩解：Pre-check Task 1.3 明列此項，刪前先確認。
- **R-2 未來若需要 native path 走回頭路**：需從 git history 恢復（所有刪除仍在 git history 裡，`git show <commit>:path/to/file.c` 可隨時取回）。Trade-off 可接受。
- **R-3 Package consumer 有沒有 import C symbol 的可能**：pre-check grep 已驗證無 `codex_provider.so`/`libcodex_provider`/`codex-native` 消費者；`package.json` exports 也只 export TS path。風險 ~0。

## Critical Files

- Tracked (to `git rm`):
  - `packages/opencode-codex-provider/src/auth.c`
  - `packages/opencode-codex-provider/src/jwt.c`
  - `packages/opencode-codex-provider/src/main.c`
  - `packages/opencode-codex-provider/src/originator.c`
  - `packages/opencode-codex-provider/src/provider.c`
  - `packages/opencode-codex-provider/src/quota.c`
  - `packages/opencode-codex-provider/src/storage.c`
  - `packages/opencode-codex-provider/src/stream.c`
  - `packages/opencode-codex-provider/src/transform.c`
  - `packages/opencode-codex-provider/src/transport.c`
  - `packages/opencode-codex-provider/include/codex_provider.h`
  - `packages/opencode-codex-provider/CMakeLists.txt`
- Untracked (to `rm -rf`):
  - `packages/opencode-codex-provider/build/`
- Doc update:
  - `specs/codex/provider_runtime/design.md` — 補 cross-reference DD
  - `plans/codex-refactor/plan.md` — 補 REMOVED 註記
  - `docs/events/event_2026-04-18_codex_c_library_removal.md` — 新增
