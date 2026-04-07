# Proposal

## Why

MCP App 的擴充目前受限於硬編碼架構：每新增一個 App 都必須修改核心模組 `app-registry.ts`。這違反開閉原則，也阻礙了使用者自行擴充能力的可能性。

本計畫的目標不僅是「拆硬編碼」，而是建立完整的 **MCP 管理層**：定義標準化的 App 檔案包規格、統一的生命週期管理、以及對話驅動的供應鏈 — 讓使用者透過自然語言即可完成 App 的取得、安裝、驗證與上架。

## Original Requirement Wording (Baseline)

- "盤點一下目前的程式架構，我想知道自製的應用市場 (mcp apps) 有沒有做到架構分離，也就是：1. 程式碼集中單一資料夾包 2. 簡單設定自動介接主程式。開一個plan來記錄分析結果並計畫架構改良。"

## Requirement Revision History

- 2026-04-06: 初始建立計畫，目標為實作自動註冊載入機制。
- 2026-04-06 (rev2): 確定採用獨立路徑集中管理所有 Apps，澄清 MCP App 與 Plugin 職責邊界。
- 2026-04-06 (rev3): 重新定位為「MCP 管理層重構」。擴充需求：
  1. App 應可作為檔案包上傳或指定路徑掛載
  2. 擴充 MCP 的能力應成為 system-manager MCP 的 tool
  3. 使用者能透過對話告訴 AI「把 GitHub 上某個功能加進來」，自動完成 clone → 安裝 → 註冊 → 上架
  4. 硬編碼拆離只是 Step 1，不是計畫全貌

## Effective Requirement Description

1. **檔案包標準（Layer 1）**：定義 `mcp.json` manifest 規格，任何符合規格的目錄即為合法 MCP App。
2. **生命週期管理（Layer 2）**：`mcp-apps.json` 集中登記、Admin UI 應用市場卡片、enable/disable/remove 全生命週期。
3. **對話驅動供應鏈（Layer 3）**：system-manager 新增 `install_mcp_app` tool，支援 GitHub URL / 本機路徑，自動完成取得 → 偵測 → 安裝 → 驗證 → 註冊。
4. **硬編碼清理（Layer 0）**：內建 Gmail/Calendar 遵循相同標準，分階段遷移。

## Scope

### IN

- 定義 mcp.json manifest schema
- 建立 mcp-apps.json 讀取/寫入層
- 重構 app-registry.ts 移除 BUILTIN_CATALOG 硬編碼
- 實作 system-manager `install_mcp_app` / `list_mcp_apps` / `remove_mcp_app` tool
- Admin UI 應用市場管理頁面（卡片預覽、新增、啟停、移除）
- Runtime 動態載入：stdio spawn → MCP Client → tools/list → tool pool 註冊

### OUT

- 不改動 MCP 底層通訊協議
- 不改動 OAuth / Token 管理核心機制（但 token 注入方式會標準化）
- 不建置網路市集（Web Plugin Marketplace）— 限本機目錄掃描 + GitHub clone
- Gmail/Calendar 獨立行程化（Phase B）不在本計畫首次交付範圍

## Non-Goals

- 網路 App Store / 線上市集
- MCP server 的沙箱隔離（未來獨立計畫）
- Provider 打包機制（概念相似但獨立計畫）

## Constraints

- 遵循 AGENTS.md 第一條：禁止靜默 Fallback，載入出錯必須 log.warn 或 throw
- mcp-apps.json 寫入需考慮 /etc/opencode/ 權限問題
- 內建 App 遷移期間必須保持向後相容

## What Changes

- `packages/opencode/src/mcp/app-registry.ts` — 移除硬編碼，改為動態載入
- `packages/opencode/src/mcp/index.ts` — 新增 stdio App 啟動路徑，移除 managedAppExecutors
- `packages/mcp/system-manager/src/index.ts` — 新增 install/list/remove tool
- `/etc/opencode/mcp-apps.json` — 新建設定檔
- `packages/opencode/src/server/routes/mcp.ts` — 新增 App CRUD API
- Frontend Admin Panel — 新增 MCP Apps 管理分頁

## Capabilities

### New Capabilities

- 對話驅動 App 安裝：使用者透過自然語言指定 GitHub repo，AI 自動完成全流程
- 檔案包掛載：指定本機路徑即可擴充 MCP App
- 應用市場 UI：卡片式管理介面

### Modified Capabilities

- MCP App 註冊機制：從硬編碼改為動態載入
- system-manager tool set：新增 App 管理能力

## Impact

- 主要影響 MCP 子系統（app-registry, index, server routes）
- system-manager MCP server 擴充
- Admin Panel 前端新增頁面
- 部署設定（/etc/opencode/mcp-apps.json）
