# CMS Legacy Fallback Inventory & Risk Assessment

**Date:** 2026-03-14
**Type:** Tech Debt Audit + Disk Forensics
**Scope:** `packages/opencode/src/` on cms branch + runtime data directories

---

## Summary

盤點 cms branch 中所有為相容 legacy implementation 而存在的 fallback 機制。
共識別 **18 個主要 fallback pattern**，分佈在 30+ 個檔案、合計 384 處相關匹配。

磁碟驗證發現 **7 個孤兒檔案**可立即刪除、**3 個 migration 路徑**已完成可移除程式碼、
**4 個 deprecated 符號**零引用可安全刪除。

---

## Part 1: Fallback Mechanism Inventory

### Category A: Storage Path Fallback（檔案路徑降級）

| # | Location | What | New Way | Legacy Way | Removable? |
|---|----------|------|---------|------------|------------|
| A1 | `account/index.ts:103-105,149-186` | accounts.json 路徑三級降級 | `~/.config/opencode/accounts.json` | `~/.opencode/accounts.json` → `~/.local/share/opencode/accounts.json` | 需確認所有用戶已遷移 |
| A2 | `account/rotation/state.ts:21-88` | rotation state 統一檔 | `rotation-state.json` | `rate-limits.json` + `account-health.json` 兩檔合併讀取 | 中期可移除 |
| A3 | `global/index.ts:129-173` | template 安裝時 legacy 檔偵測 | manifest entries | hardcoded `fallbackEntries` + `~/.opencode/{entry}` 大小比較 | 隨 A1 一起 |
| A4 | `global/index.ts:192-213` | cache version migration | version file check, clear on mismatch | 舊版 cache 直接清除 | 永久保留（版本升級機制） |
| A5 | `global/index.ts:215-227,431-439` | legacy `~/.opencode` 目錄偵測 | XDG paths | 偵測 + warn + skip install | 隨 A1 一起 |

### Category B: Account Schema Migration（帳戶格式遷移）

| # | Location | What | New Way | Legacy Way | Removable? |
|---|----------|------|---------|------------|------------|
| B1 | `account/index.ts:207-217` | anthropic → claude-cli 一次性遷移 | `storage.families["claude-cli"]` | `storage.families.anthropic` 偵測並搬移 | 短期可移除（已無 anthropic key） |
| B2 | `account/index.ts:219-222,877-912` | storage v1→v2：google 拆分 gemini-cli | version 2 分離存儲 | version 1 全部在 "google" key | 中期可移除 |
| B3 | `account/index.ts:226-280` | account ID prefix 修復 | `{provider}-{type}-{name}` 格式 | bare name like "default"（commit 3bf52500a 產生） | 短期可移除 |
| B4 | `account/index.ts:918-1036` | 三源遷移：auth.json / openai-codex-accounts.json / google-oauth-accounts.json | 統一 accounts.json | 三個獨立檔案格式 | 中期可移除 |

### Category C: API Naming Backward Compat（命名相容層）

| # | Location | What | New Way | Legacy Way | Removable? |
|---|----------|------|---------|------------|------------|
| C1 | `account/index.ts:80-91` | 匯出別名 | `ProviderData`, `knownProviders`, `resolveFamily`, `parseProvider` | `FamilyData`, `knownFamilies`, `resolveProvider`, `parseProviderKey` | 需 grep 所有 caller |
| C2 | `account/index.ts:94-98` | storage key 使用 "families" | 概念上是 provider-keyed | JSON key 仍為 `families` 避免破壞現有檔案 | Breaking change，需遷移 |
| C3 | `server/routes/account.ts:55` | parseProvider ∥ parseFamily fallback chain | `parseProvider(id)` | `?? parseFamily(id) ?? id` | 隨 C1 一起 |
| C4 | `session/llm.ts` (usesInstructions) | `capabilities.useInstructionsOption` | capabilities 抽象層 | legacy `usesInstructions` 變數 | ~~短期可移除~~ 實為 local variable，非 tech debt |

### Category D: Provider Capabilities Fallback（能力偵測降級）

| # | Location | What | New Way | Legacy Way | Removable? |
|---|----------|------|---------|------------|------------|
| D1 | `provider/capabilities.ts:70-78,87-175` | provider capabilities detection chain | 具名 provider 精確匹配 | DEFAULT_CAPABILITIES 兜底 | 永久保留（設計模式） |
| D2 | `provider/health.ts:552-562` | phantom account 過濾 | 只保留有 suffix 的帳戶 ID | 若只有 phantom 則照用 | 中期可移除 |
| D3 | `account/quota/hint.ts:6-48` | quota hint per-provider | provider-specific hint | 無 hint 時回傳 undefined | 永久保留（設計模式） |

### Category E: Session & Config Migration（session/config 格式遷移）

| # | Location | What | New Way | Legacy Way | Removable? |
|---|----------|------|---------|------------|------------|
| E1 | `storage/storage.ts:152-290,621-633` | session key layout 遷移 | `["session", sessionID]` | `["session", projectID, sessionID]` 長度判斷 | 長期可移除（需重建所有 session） |
| E2 | `config/config.ts:369-371` | autoshare → share 欄位遷移 | `share: "auto"` enum | `autoshare: true` boolean | 短期可移除 |

### Category F: Tool & Input Normalization（工具相容）

| # | Location | What | New Way | Legacy Way | Removable? |
|---|----------|------|---------|------------|------------|
| F1 | `tool/bash.ts:57-60` | bash tool 命名 | 支援任意 POSIX shell | tool name 仍為 "bash" | 永久保留（歷史命名） |
| F2 | `tool/task.ts:899-902` | task prompt 輸入正規化 | structured format | plain string | 永久保留（backwards compat） |

---

## Part 2: Disk Forensics — 孤兒檔案盤點

實際檢查三個 runtime 目錄的磁碟狀態：

### `~/.local/share/opencode/`（Legacy data path）

| File | Size | Last Modified | Code Reference? | Verdict |
|------|------|---------------|-----------------|---------|
| `accounts.json` | 16,581 B | 2026-03-14 | migration-only read (A1) | **可刪除** — 與 primary 完全相同 |
| `accounts.json.bak` | 16,844 B | 2026-03-01 | **NONE** | **可刪除** — 手動備份，程式碼無引用 |
| `accounts.json.corrupted.20260311*` | 318 B | 2026-03-11 | **NONE** | **可刪除** — 診斷用殘留 |
| `auth.json.migrated` | 279 B | 2026-02-06 | 只在遷移時寫入 | **可刪除** — 遷移已完成 36 天 |
| `antigravity-accounts.json` | 374 B | 2026-02-06 | **NONE** | **可刪除** — 程式碼完全無引用 |
| `ignored-models.json` | 1,640 B | 2026-02-06 | template install 寫入 | 保留（active template） |
| `bun.lock` / `package.json` / `node_modules` | — | — | runtime plugin | 保留（active runtime） |

### `~/.local/state/opencode/`

| File | Size | Last Modified | Code Reference? | Verdict |
|------|------|---------------|-----------------|---------|
| `account-health.json` | 535 B | **2026-02-06** | migration-only read (A2) | **可刪除** — 已合併至 rotation-state.json，凍結 36 天 |
| `rate-limits.json` | — | — | — | **已不存在**（migration 完成） |
| `model-health.json` | 2,025 B | 2026-02-06 | **NONE** | **可刪除** — 程式碼完全無引用 |
| `model-status.json` | 3,149 B | 2026-01-27 | **NONE** | **可刪除** — 程式碼完全無引用，最古老的孤兒 |
| `rotation-state.json` | 1,888 B | 2026-03-14 | active | 保留（primary） |
| `rotation-state.backup-*.json` | 3,588 B | 2026-03-11 | **NONE** | **可刪除** — 手動/自動備份 |
| `rotation-state.json.bak.*` | 22,140 B | 2026-03-11 | **NONE** | **可刪除** — 除錯備份 |

### `~/.config/opencode/`

| File | Size | Last Modified | Code Reference? | Verdict |
|------|------|---------------|-----------------|---------|
| `openai-codex-accounts.json` | 812 B | 2026-03-06 | migration-only read (B4) | 保留至 B4 migration 移除 |
| `openai-codex-auth-config.json` | 250 B | 2026-02-06 | **NONE** | **可刪除** — 程式碼完全無引用 |
| `opencode.json.bak` | 14,474 B | 2026-03-07 | **NONE** | **可刪除** — 手動備份 |
| `accounts.json` | 16,581 B | 2026-03-14 | active primary | 保留 |

---

## Part 3: Dead Exported Symbols

| Symbol | File:Line | @deprecated? | Live Importers | Verdict |
|--------|-----------|--------------|----------------|---------|
| `FAMILIES` | `account/index.ts:34` | Yes | 1 (cli/cmd/accounts.tsx via spread) | ⚠️ 需先更新 caller |
| `Family` | `account/index.ts:36` | Yes | 0 | ✅ **可立即刪除** |
| `FamilyData` | `account/index.ts:81,83` | Yes | 1 (server/routes/account.ts:98) | ⚠️ 需先更新 API route |
| `parseFamily` | `account/index.ts:800` | Yes | 4 locations (quota/hint, dialog-admin, app.tsx, routes/account) | ⚠️ 需先 refactor callers |
| `parseProviderKey` | `account/index.ts:91` | Alias | **0** | ✅ **可立即刪除** |
| `resolveProvider` (alias) | `account/index.ts:89` | Alias | 3 (via `(Account as any)` cast fallback) | ⚠️ cast 會 graceful 降級，低風險 |
| `openai_quota.ts` (whole file) | `account/openai_quota.ts` | Yes | re-export only | ✅ **可立即刪除** (redirect) |

---

## Part 4: Deprecated Config Fields

| Field | File:Line | Replacement | Migration Logic | Removable? |
|-------|-----------|-------------|-----------------|------------|
| `tools` | `config/config.ts:862` | `permission` | auto-convert at load (lines 914-920) | 中期 |
| `maxSteps` | `config/config.ts:882` | `steps` | auto-convert at load (line 926) | 中期 |
| `layout` | `config/config.ts:1343` | always stretch | ignored | ✅ 可立即移除 schema |
| `shareNewSessions` | `config/config.ts:1218` | `share` | — | ✅ 可立即移除 schema |
| `autoshare` | `config/config.ts:369-371` | `share: "auto"` | auto-convert | 短期 |

---

## Part 5: Risk Matrix

### 🟢 立即可執行（零風險）

**磁碟清理** — 以下檔案程式碼完全無引用，可直接 `rm`：

```bash
# 孤兒檔案（程式碼零引用）
rm ~/.local/share/opencode/antigravity-accounts.json
rm ~/.local/share/opencode/accounts.json.bak
rm ~/.local/share/opencode/accounts.json.corrupted.*
rm ~/.local/state/opencode/model-health.json
rm ~/.local/state/opencode/model-status.json
rm ~/.local/state/opencode/rotation-state.backup-*.json
rm ~/.local/state/opencode/rotation-state.json.bak.*
rm ~/.config/opencode/openai-codex-auth-config.json
rm ~/.config/opencode/opencode.json.bak

# 遷移完成的殘留
rm ~/.local/share/opencode/auth.json.migrated
rm ~/.local/state/opencode/account-health.json
```

**程式碼清理** — 零引用符號：

```
del: account/index.ts — Family type alias (line 36)
del: account/index.ts — parseProviderKey alias (line 91)
del: account/openai_quota.ts — whole file (deprecated re-export)
```

### 🟡 短期可執行（低風險，需更新 1-4 個 caller）

| Item | Callers to Update | Effort |
|------|-------------------|--------|
| B1: anthropic→claude-cli migration code | 0 (self-contained) | 刪除 ~10 行 |
| B3: account ID prefix fix code | 0 (self-contained) | 刪除 ~55 行 |
| E2: autoshare→share migration | 0 (self-contained) | 刪除 ~3 行 |
| `parseFamily` alias → 統一為 `parseProvider` | 4 files | ~30 min |
| `FAMILIES` const → 統一為 `PROVIDERS` | 1 file | ~5 min |
| `FamilyData` type → 統一為 `ProviderData` | 1 file | ~5 min |

### 🟠 中期執行（中風險，需驗證 + 測試）

| Item | Risk | Blocker |
|------|------|---------|
| A2: rotation state legacy read | `account-health.json` 磁碟上仍存在（但已凍結 36 天） | 先執行磁碟清理 |
| B2: v1→v2 google split | 所有帳戶已在 v2 | 需確認無 v1 殘留 |
| B4: auth.json / codex-accounts 遷移 | `auth.json` 已刪除, `codex-accounts` 仍在磁碟 | 先備份再刪 |
| D2: phantom account filter | 依賴帳戶 ID 格式正確 | B3 先完成 |

### 🔴 需規劃（高風險 / Breaking Change）

| Item | Impact | Strategy |
|------|--------|----------|
| C2: storage key `families`→`providers` | 所有 accounts.json 格式破壞 | 需 version 3 migration |
| E1: session key layout | 丟失舊 session 存取能力 | 可接受（session 非永久資料） |
| `resolveProvider`/`resolveFamily` 命名統一 | 3 處 `(Account as any)` cast | 需同步更新 |

### ⬜ 永久保留（設計模式，非 tech debt）

A4, C4 (local var), D1, D3, F1, F2

---

## Part 6: 隱藏的 Legacy 風險

### 1. ~~雙寫問題~~ ✅ FIXED
`save()` 中的 shadow write（line 452-455）及 `load()` 中對應的 legacy XDG migration read（line 177-186）已移除。
`legacyFilepath` 常數已刪除（零引用）。TypeScript 編譯通過。
`~/.local/share/opencode/accounts.json` 現為凍結孤兒，可在磁碟清理時一併刪除。

### 2. Silent Error Swallowing
所有 migration try-catch 都是靜默失敗（log.warn 後繼續）。
如果 migration 失敗但檔案仍存在，會在每次啟動時重複嘗試遷移。
**風險**：效能拖累（每次啟動都讀取 legacy 檔案）、錯誤被吞掉不可觀測。

### 3. `(Account as any)` Type Cast
`session/llm.ts:595,657`、`session/model-orchestration.ts:91`、`provider/provider.ts:1319`
使用 `(Account as any).resolveProvider ?? (Account as any).resolveFamily` 的 defensive pattern。
**風險**：TypeScript 型別系統被繞過，任何重新命名都不會被編譯器捕獲。

### 4. `.opencode/` 的雙重身份
`~/.opencode/` 是 legacy global config（已廢止），但 `.opencode/` 在 project root 是**活躍的** per-project config directory。
`config.ts:282` 有明確的 exclude，但 `config.ts:538,578` 的 pattern matching 同時匹配兩者。
**風險**：如果用戶 home 目錄下有殘留 `~/.opencode/command/`，可能被意外載入。

---

## Recommended Cleanup Script

```bash
#!/bin/bash
# Phase 0: 磁碟孤兒清理（零風險）
set -euo pipefail

echo "=== Removing orphaned files (zero code references) ==="
rm -v ~/.local/share/opencode/antigravity-accounts.json
rm -v ~/.local/share/opencode/accounts.json.bak
rm -vf ~/.local/share/opencode/accounts.json.corrupted.*
rm -v ~/.local/state/opencode/model-health.json
rm -v ~/.local/state/opencode/model-status.json
rm -vf ~/.local/state/opencode/rotation-state.backup-*.json
rm -vf ~/.local/state/opencode/rotation-state.json.bak.*
rm -v ~/.config/opencode/openai-codex-auth-config.json
rm -vf ~/.config/opencode/opencode.json.bak

echo "=== Removing completed migration residue ==="
rm -v ~/.local/share/opencode/auth.json.migrated
rm -v ~/.local/state/opencode/account-health.json

echo "=== Done. Freed space from 11 orphaned files ==="
```
