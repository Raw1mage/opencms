# Event: Anthropic Protocol Decoupling & Pure CLI Mimicry

Date: 2026-02-08
Status: Execution In Progress
Topic: Protocol Reverse Engineering

## 1. 需求分析 (Requirement Analysis)

- **核心目標**：使 OpenCode 發出的 Anthropic 訂閱封包與官方 Claude Code CLI (v2.1.37) 100% 一致。
- **排除干擾**：移除 OpenCode 框架自動注入的 `providerOptions`、`cacheControl` 以及過時的標頭。
- **補全特徵**：實作官方專有的動態 `x-anthropic-billing-header` (Attribution Hash)。

## 2. 執行計畫 (Execution Plan)

- [x] **Step 1: 知識紀錄** - 建立此計畫文件。
- [ ] **Step 2: 框架解耦** - 修改 `src/provider/provider.ts` 移除硬編碼標頭。
- [ ] **Step 3: 轉換過濾** - 修改 `src/provider/transform.ts` 在訂閱模式下禁用自動快取注入。
- [ ] **Step 4: 終極淨化** - 在 `src/plugin/anthropic.ts` 中手動清理 `message` 欄位並加入動態 Billing Hash。

## 3. 關鍵發現 (Key Evidence)

- `transform.ts` 會自動加入 `anthropic: { cacheControl: "ephemeral" }`，這在 Sessions API 協議中被視為非法欄位。
- `provider.ts` 殘留 0.5.1 版本號，與模擬的 2.1.37 發生指紋衝突。
- 官方 CLI 使用 `sha256(salt + content_sample + version)` 產生動態 Hash 放入 Billing Header。

## 4. 預期結果

- 成功建立 Session 並通過 `/events` 同步訊息。
- 徹底消除 "Credential authorized only for Claude Code" 報錯。
