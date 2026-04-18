# Proposal: codex-c-library-removal

## Why

- `packages/opencode-codex-provider/` 內含 10 個 `.c` 檔 + `include/codex_provider.h` + `CMakeLists.txt` + `build/` 輸出的 `codex_provider.so`，設計為可被 TS 端 `bun:ffi` 載入的 native library（對照 `packages/opencode/src/plugin/claude-native.ts` 用 `dlopen("claude_provider.so")` 的做法）。
- **實際情況**：沒有任何 TS 檔載入 `codex_provider.so`，也沒有 `codex-native.ts`。`packages/opencode-codex-provider/src/index.ts` 只 export TS 檔；`provider.ts` 透過 `fetch` + `tryWsTransport` 直接走網路，完全不經 C 層。
- **歷史**：
  - `21f4af0a2` / `29b9cb72d` (2026-Q1) 加入完整 C 實作
  - `9b48a4503` 後轉向 TS `LanguageModelV2` 實作
  - `plans/codex-refactor/plan.md` 線路上寫「移除 codex-native.ts」，但整個 codex C library 被留下
- **副作用**：
  - 2026-04-18 本次診斷錯誤的起點：看到 `transport.c` 有明顯的 429 硬 retry loop，誤認為是線上活動路徑、立刻動手寫 fix plan。浪費時間、差點改錯。
  - 未來若有人維護、看到類似「看起來可用」但實際死的 C code，會重複同樣的誤判。
  - `CMakeLists.txt` + `Werror` + `find_package(CURL/OpenSSL/cJSON)` 持續佔環境依賴成本，新開發者被迫理解一條不存在的路徑。

## Original Requirement Wording (Baseline)

- 「清除死碼，重新抓RCA病灶寫revision plan」（2026-04-18，分工為此 spec + `2026-04-18_subagent-rotation-rca`）

## Requirement Revision History

- 2026-04-18: initial draft — 刪除整組 codex C library + build artifacts

## Effective Requirement Description

1. 刪除 `packages/opencode-codex-provider/` 下所有 C 語言來源與標頭：`src/*.c`、`include/codex_provider.h`。
2. 刪除 `CMakeLists.txt` 與 `build/` 目錄（native library build 產物）。
3. 保留所有 `*.ts` 檔案（TS provider 實作，線上活動）。
4. 確認 git 刪除後 `bun install` / `bun run typecheck` 仍能跑；無檔案被 TS 端引用。

## Scope

### IN
- `packages/opencode-codex-provider/src/*.c` — 10 個檔案全刪
- `packages/opencode-codex-provider/include/codex_provider.h`
- `packages/opencode-codex-provider/CMakeLists.txt`
- `packages/opencode-codex-provider/build/`（全目錄）
- `packages/opencode-codex-provider/.gitignore` — 視情況調整

### OUT
- `packages/opencode-codex-provider/src/*.ts` — 線上活動，不動
- `packages/opencode-codex-provider/src/*.test.ts` — 測試檔，不動
- `packages/opencode/src/plugin/claude-native.ts` 與 `claude_provider.so` — claude 家族另一個議題，本 spec 不處理
- 其他 provider 的死碼審查 — 另立

## Non-Goals

- 不碰 TS provider 行為、API、protocol 定義。
- 不調整 CI / build pipeline 外的設定。
- 不重構 `@opencode-ai/codex-provider` package 結構。

## Constraints

- AGENTS.md「Never rm Tracked Files」記憶：刪檔前必須 `git ls-files` 列出並人眼確認。
- Delete 必須在 beta worktree 做、merged 後 fetch-back，禁止主線直刪。
- build artifact 已在 `.gitignore` 則直接刪目錄；若被 tracked 要正式 `git rm`。

## What Changes

1. `git rm packages/opencode-codex-provider/src/{auth,jwt,main,originator,provider,quota,storage,stream,transform,transport}.c`
2. `git rm packages/opencode-codex-provider/include/codex_provider.h`
3. `git rm packages/opencode-codex-provider/CMakeLists.txt`
4. `rm -rf packages/opencode-codex-provider/build/`（若未 tracked）
5. `.gitignore` 整理

## Capabilities

### New Capabilities
- 無（純清理）。

### Modified Capabilities
- `@opencode-ai/codex-provider` package 變為純 TS package，不再宣稱支援 native FFI 路徑。

## Impact

- **Code**：僅 `packages/opencode-codex-provider/` 內，不觸及消費端。
- **Build**：不再執行 CMake build。如果 CI 有呼叫 `cmake` 或 `make` 需同步移除。
- **Docs**：`specs/codex/provider_runtime/` 與 `plans/codex-refactor/plan.md` 若有提到 C library 要補「已移除」註記。
- **Risk**：極低。死碼 = 刪除沒消費者。
