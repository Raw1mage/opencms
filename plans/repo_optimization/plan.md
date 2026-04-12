# Repo Optimization Plan

**日期**: 2026-04-13
**目標**: 清理垃圾、移除過時產物、減少外部依賴、改善 repo 整潔度

## 執行記錄

- [x] **Phase 1** — 垃圾清除：.turbo(4.1G), .ruff_cache, stale logs, refs/claw-code/, build-switch.txt, migration bundle(155MB)
- [x] **Phase 2.1** — 移除 chokidar（零 import）
- [x] **Phase 2.2** — strip-ansi → inline regex 替代（2 處）
- [x] **Phase 2.3** — xdg-basedir → 4 行 process.env 替代
- [x] **Phase 3.1** — 移除 ModelHealthRegistry deprecated 註解墓碑
- [x] **Phase 3.2** — 移除 github.ts commented-out code
- [x] **Phase 3.3** — 移除 normalizeProviderFamily + isPromptQuotaProviderFamily deprecated aliases
- [x] **Phase 5** — 歸檔 4 plans: plan-tool-cleanup, published-web-sidebar, 20260408_webapp, subagent-evolution
- [x] **Phase 6.1** — 7 個 one-shot patch scripts → recyclebin/patches/
- [x] **Phase 2.4** — clipboardy → native clipboard text reading（pbpaste/wl-paste/xclip/xsel/powershell）
- [x] **Phase 3.4** — disabled test suites 審查：刪除 2 個 enabled_providers dead tests，re-enable unicode snapshot test（通過），保留 3 個 env-flaky tests
- [x] **Phase 4** — refs/ 全部保留（使用者決定）
- [x] **Phase 6.2** — 記錄 3 個非穩定依賴：@solidjs/start(PR-preview), nitro(alpha), @clack/prompts(alpha)，待上游穩定後更新

---

## Phase 1: 垃圾清除（零風險）

### 1.1 空/死亡檔案

| 檔案 | 狀態 | 動作 |
|------|------|------|
| `refs/claw-code/` | 空目錄，非 active submodule | 刪除 |
| `packages/opencode/src/session/prompt/build-switch.txt` | 0 bytes 空檔 | 確認無引用後刪除 |
| `recyclebin/provider-key-migration-20260313-1.bundle` | 155MB，一個月前的遷移備份 | 確認遷移完成後刪除 |

### 1.2 Build cache / Log

| 項目 | 大小 | 動作 |
|------|------|------|
| `.turbo/` | 4.1G | `rm -rf .turbo/`（turbo 會自動重建） |
| `build.log` | 4.7K（3月3日） | 刪除 |
| `openapi-ts-error-*.log` | stale error log | 刪除 |
| `.ruff_cache/` | 36K | 刪除 |

### 1.3 Untracked 文件歸檔

| 檔案 | 動作 |
|------|------|
| `docs/prompt_injection.md` | 有價值，commit 進 repo |
| `docs/sdd_framework.md` | 有價值，commit 進 repo |
| `scripts/migrate-orphaned-sessions.ts` | 遷移完成後刪除，或 commit 留檔 |

---

## Phase 2: 依賴瘦身（脫離外部套件）

### 2.1 可直接移除 — `chokidar`

- **現況**: root devDependencies 列出，但 `packages/` 下零 import
- **動作**: 從 package.json 移除
- **風險**: 無

### 2.2 可內建替代 — `strip-ansi`

- **現況**: 2 處使用（`packages/ui/src/components/message-part.tsx`, `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`）
- **替代**: 一行 regex — `text.replace(/\x1b\[[0-9;]*m/g, "")`
- **動作**: 建立 `packages/opencode/src/util/strip-ansi.ts` 或直接 inline，移除依賴
- **風險**: 低（regex 涵蓋常見 SGR 序列；完整版需 `/\x1b\[[\d;]*[A-Za-z]/g`）

### 2.3 可內建替代 — `xdg-basedir`

- **現況**: 1 處使用（`packages/opencode/src/global/index.ts`），僅讀取 4 個 env var
- **替代**:
  ```ts
  const xdgData = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share")
  const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  const xdgState = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state")
  ```
- **動作**: inline 替代，移除依賴
- **風險**: 無（xdg-basedir 的實作就是這 4 行）

### 2.4 可降級依賴 — `clipboardy`

- **現況**: 1 處使用（`packages/opencode/src/cli/cmd/tui/util/clipboard.ts`）
- **分析**: clipboard.ts 已經自己實作了 darwin/linux/win32/WSL 的 read+write。`clipboardy` 僅作為 text read/write 的 **最後 fallback**（L308, L386）
- **替代**: 將 clipboardy 的 text fallback 也用同樣的 `Bun.spawn` + 系統指令方式覆蓋，移除依賴
- **風險**: 中（需確認 fallback path 覆蓋所有 platform）

### 2.5 保留但記錄理由

| 依賴 | 使用處 | 保留理由 |
|------|--------|----------|
| `decimal.js` | session/index.ts（token cost 精確計算） | 金額計算需 arbitrary precision，替代風險高 |
| `turndown` | tool/webfetch.ts（HTML→Markdown） | 無輕量替代，自寫 converter 維護成本高 |
| `jsonc-parser` | config.ts + mcp.ts（JSONC 解析+修改） | 需要 `modify`+`applyEdits` API，無 built-in 替代 |
| `@parcel/watcher` | file/watcher.ts（檔案監視） | 僅 type import + dynamic require，是 fs.watch 的高效替代 |
| `bonjour-service` | server/mdns.ts | mDNS 協議複雜，無 built-in |
| `authenticate-pam` | server/web-auth-credentials.ts | Linux PAM 認證，無替代 |

---

## Phase 3: 程式碼清理

### 3.1 已標記 deprecated — ModelHealthRegistry

- **位置**: `packages/opencode/src/account/rotation/index.ts:71`
- **狀態**: 標記 "DEPRECATED — Phase 4 removal"，無人寫入，所有消費者用 RateLimitTracker
- **動作**: 移除 dead code

### 3.2 Commented-out code

- **位置**: `packages/opencode/src/cli/cmd/github.ts:235` — `//const key = await promptKey()`
- **動作**: 刪除 commented-out 程式碼

### 3.3 @deprecated API markers（app 層）

- `packages/app/src/components/model-selector-state.ts` — 2 個 deprecated function
- `packages/app/src/components/prompt-input/quota-refresh.ts` — 1 個 deprecated function
- **動作**: 確認無 caller 後刪除

### 3.4 Disabled test suites

- `test/session/llm.test.ts` — `describe.skip` 整個 suite
- `test/provider/provider.test.ts` — 1 個 `test.skip`
- `test/provider/gitlab-duo.test.ts` — 多個 `test.skip`
- `test/snapshot/snapshot.test.ts` — unicode filenames skip
- `test/plugin/auth-override.test.ts` — user plugin override skip
- **動作**: 逐一審查，能修就修，確認已廢棄就刪除

---

## Phase 4: refs/ 整理

### 現況（230MB）

| 目錄 | 大小 | 用途 |
|------|------|------|
| `claude-code/` | 13M | active submodule (v2.1.80)，prompt/行為參考 |
| `claude-code-npm/` | 43M | NPM 包裝，上次用途不明 |
| `openclaw/` | 114M | 架構參考（cron, daemon, retry patterns） |
| `codex/` | 48M | Codex SDK 參考 |
| `openspec/` | 6.7M | active submodule，API spec 工具 |
| `opencode-antigravity-auth/` | 1.8M | Antigravity OAuth |
| `opencode-gemini-auth/` | 404K | Gemini OAuth |
| `vscode-antigravity-cockpit/` | 4.9M | VSCode extension |
| `claw-code/` | 0 | 空目錄（Phase 1 刪除） |

### 建議

- **確認 `claude-code-npm/` 是否仍需要** — 若 `claude-code/` 已足夠，43MB 可回收
- **確認 `openclaw/` 參考頻率** — 114MB 最大宗，若僅偶爾查閱可改用 remote fetch on-demand
- **`opencode-antigravity-auth/` 和 `opencode-gemini-auth/`** — 確認是否已 inline 進 main，若是則可移除

---

## Phase 5: Stale Plans 歸檔

### 已完成或不再活躍的 plans

逐一審查以下 plans，已完成的移入 `recyclebin/plans/` 或直接刪除：

| Plan | 預判 |
|------|------|
| `plan-tool-cleanup/` | 大部分已 merge（plan_enter/plan_exit 已移除） |
| `claude-provider/` | 確認是否已完成 |
| `published-web-sidebar/` | 最近 commit 顯示已 merge |
| `codex-refactor/` | Phase 1 merged，Phase 2 planned — 保留 |
| `personality-layer/` | 確認進度 |
| `context-dispatch-optimization/` | 確認進度 |
| `subagent-evolution/` + `subagent-taxonomy/` | 確認是否合併或已廢棄 |

---

## Phase 6: 構建配置統一

### 6.1 Root-level patch files

- 7 個 `patch-*.js` + 3 個 `*.fix.js` 散落 root
- **動作**: 移入 `scripts/patches/` 統一管理，或確認哪些已不需要

### 6.2 Alpha/PR-preview 依賴

- `@solidjs/start` — 使用 PR preview URL (`pkg.pr.new/...@dfb2020`)，非 stable release
- `nitro` — v3.0.1-alpha.1
- **動作**: 記錄為已知風險，待上游穩定後更新

---

## 優先序與預估影響

| Phase | 預估節省 | 風險 | 建議順序 |
|-------|----------|------|----------|
| Phase 1 — 垃圾清除 | ~4.3G（含 .turbo） + 155MB | 零 | 立即執行 |
| Phase 2.1-2.3 — 移除 chokidar/strip-ansi/xdg-basedir | 減少 3 個外部依賴 | 低 | 立即執行 |
| Phase 2.4 — 移除 clipboardy | 減少 1 個外部依賴 | 中 | 需測試 |
| Phase 3 — 程式碼清理 | 清潔度提升 | 低 | 本週 |
| Phase 4 — refs 整理 | 最多 ~160MB | 需確認 | 需討論 |
| Phase 5 — Plans 歸檔 | 整潔度 | 零 | 本週 |
| Phase 6 — 配置統一 | 維護性 | 低 | 排程 |
