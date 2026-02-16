# Event: Add claude-code as git submodule

Date: 2026-02-08
Status: In Progress

## 1. 需求分析

- 將 https://github.com/anthropics/claude-code 建立為 `refs/` 下的一個 submodule。
- 目標路徑：`/home/pkcs12/opencode/refs/claude-code`

## 2. 執行計畫

- [x] 初始化任務與建立事件紀錄 (Done)
- [x] 檢查路徑衝突 (Done)
- [x] 執行 `git submodule add` (Done)
- [x] 驗證結果 (Done)
- [x] 分析 `claude-code` 並更新 `anthropic.ts` (Done)

## 3. 關鍵決策與發現

- 確定 `refs/` 目錄已存在於根目錄。
- 由於 `.gitignore` 忽略了 `refs/` 目錄，執行 `git submodule add` 時需加上 `-f` 參數。
- 通過分析 `claude-code` (v2.1.29) 的 `cli.js` 發現以下關鍵差異：
    - OAuth Scope 增加了 `user:sessions:claude_code` 與 `user:mcp_servers`。
    - 域名從 `console.anthropic.com` 遷移至 `platform.claude.com`。
    - `User-Agent` 格式更新為 `claude-cli/2.1.29 (external, npm)`。
    - 移除了 `anthropic-client` 標頭。
    - 新增了 `x-app: cli` 與 `x-anthropic-additional-protection: true`。
    - Beta 旗標增加了 `prompt-caching-scope-2026-01-05` 等。
- 已同步更新 `src/plugin/anthropic.ts` 以符合最新版 CLI 的行為。

## 4. 遺留問題 (Pending Issues)

- 無
