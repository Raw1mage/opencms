# Event: Remove Internal UA from Provider

Date: 2026-02-08
Status: Adjusted
Topic: Protocol Mimicry

## 1. 調整原因

- 在 `src/provider/provider.ts` 中發現了隱藏的 UA 設定，這解釋了為何之前的 Log 中會出現 `User-Agent: anthropic-claude-code/0.5.1`。
- 這些設定是為了模擬官方 CLI 而加入的，但根據 `S0` 函數的證據，官方 CLI 根本不發送這些 Headers。
- 這些 Headers 變成了「特徵」，導致 API 識別出我們是非官方客戶端 (Credential mismatch)。

## 2. 修正內容

- **移除**: 在 `src/provider/provider.ts` 中，針對 `anthropic` 且 `subscription` 的帳號，移除了 `User-Agent` 與 `anthropic-client` 的設定。
- **保留**: 僅保留 `anthropic-beta` (必要功能) 與 `Authorization`。
- **主動清除**: 在 `fetch` 攔截器中加入了 `headers.delete("User-Agent")`，確保上游不會帶入預設 UA。

## 3. 預期行為

- 請求將變得極為乾淨，僅包含必要的認證與版本資訊。
- 這與官方原始碼的行為一致。
- 預期能解決 `Credential only authorized for use with Claude Code` 錯誤。
