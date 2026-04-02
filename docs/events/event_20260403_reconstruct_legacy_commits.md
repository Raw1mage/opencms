# 大回歸後遺留 Commits 修補與 TheSmartAI Branding 復原

## 背景 (Situation)
在使用 `rebase` / `reset` 整併 beta 分支到 `main` 時，發生了 42 個原先存在於 `origin/dev` 或各項重構任務中的 commits 遺失。其中包含了基礎的 TheSmartAI 品牌設定 (logo, title)，以及若干關鍵模組的重構：
1. `R2.4/R2.6`: 子代理 (Subagent) 生命週期、compaction loop breaker 與狀態防撞機制。
2. `R2.5`: `MessageV2` 中將 `image` 解析轉換成標準化 `media` 解析 (對齊最新 `main` 實作)。
3. `R4.1/R4.2`: 全域樣板設定 `Global.Path` 與 `OPENCODE_TEMPLATES_DIR` 的支援，以及啟動時寫入用戶 Shell profile 代碼。
4. `R6`: `gpt-5-mini` 與 `gpt-5.4-mini` 的 reasoning 支援標記。

## 作法 (Action)
1. 把當前 `main` 上最新實作與遺失的 commits 進行比對。
2. 以 patch 形式手動將關鍵功能逐一融合進對應模組 (`src/global/index.ts`, `src/session/message-v2.ts`, 等)，避免直接 merge 造成與近期 `main` (如 subagent state) 的衝突。
3. 復原 favicon SVG 檔案，並在 `index.html` 將 `<title>OpenCode</title>` 改回 `<title>TheSmartAI</title>`。
4. 修正因 `image` 轉換為 `media` type 所引發的 test failure。
5. 完成後一併納入 commit 提交至 `main`。

## 結果 (Result)
* `npm run test` 針對所更動模組及其他全域依賴正常通過 (排除使用者本機 global accounts 配置導致的偶發測試污染)。
* 所有遺漏之 42 個 commits 相關且重要/相容的部分已全數以重構形式 `feat(recovery): restore missing TheSmartAI branding and 20260402 commit slices` 被納回 `main` 主線中。

