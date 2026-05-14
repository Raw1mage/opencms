# Handover — AI SDK 漸進拔除 · 階段 0

> 開新 session 處理時，把下面整段（從「## 你接手...」開始到結尾）貼進去即可。
> 寫於 2026-04-24，承接當天 gpt-5.5 envelope 事件後的架構決策。

---

## 你接手一個多階段的架構重構

把 opencode 對 `@ai-sdk/*` 的依賴漸進拔除，換成 opencode 自有的協定型別。原因、起點、邊界都已經對齊好。

## 為什麼做這件事

2026-04-24 一個 bug：codex-provider 的 `convert.ts` 把 LMv2 tool-result envelope（`{type:"text",value:"..."}` 與 `{type:"content",value:[...]}`）整包 `JSON.stringify` 後送給 Codex，污染 Codex server-side memory，post-compaction 後 gpt-5.5 模仿 JSON 形狀輸出到 assistant text。修了源頭 + 加 fail-loud guard（commit `a7b2812c2`、`5bb6d319e`、`c26d7e0bf`）。

但根因不是「實作疏忽」，而是 AI SDK 把 `result.result` 標成 `unknown`，opencode 才被迫在 runtime 用 shape detection 處理。如果 envelope 是 opencode 自有 discriminated union，TypeScript 編譯期就會攔下漏處理的 case，這 bug 從根不會發生。所以使用者決定：漸進拔除 AI SDK 依賴，從小做起。

## 整體路線（不是這次任務範圍，只是脈絡）

| 階段 | 拔什麼 |
|---|---|
| **0** | LMv2 tool-result envelope 型別 ← **這次任務** |
| 1 | LMv2 stream part 型別 |
| 2 | LMv2 prompt / message 型別 |
| 3 | Provider 介面（`LanguageModelV2`） |
| 4 | `streamText` / `generateText` 編排（最大工程） |

階段 0–2 是「介面平移、行為不變」，純加型別不動邏輯。階段 3–4 才是架構切換。

## 你的任務 — 只做階段 0

新增 `packages/opencode/src/protocol/tool-result.ts`：

```ts
export type OcToolResultOutput =
  | { kind: "string"; value: string }
  | { kind: "text-envelope"; value: string }              // {type:"text",value:"..."}
  | { kind: "content-envelope"; items: OcContentItem[] }  // {type:"content",value:[...]}
  | { kind: "structured"; text: string; attachments?: OcAttachment[] }

export type OcContentItem =
  | { type: "text"; text: string }
  | { type: "media"; mediaType: string; data: string }

export type OcAttachment = { type: "file"; mime: string; url: string }

// 從 LMv2 result.result 的 unknown 形狀收斂成 union
export function fromLmv2(raw: unknown): OcToolResultOutput { ... }
```

然後改寫：
- `packages/provider-codex/src/convert.ts` 的 `case "tool"`：改成 `switch (oc.kind)` + 沒有 `default`（TypeScript exhaustive check）。把目前 4 個分支對應到 4 個 kind。
- `packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.ts` 與 `.../chat/convert-to-openai-compatible-chat-messages.ts` 同樣改寫 `case "tool"`，共用同一個 `OcToolResultOutput` union。
- `packages/opencode/src/session/message-v2.ts:710` 的 `toModelOutput` 必要時更新輸出 shape 與 `fromLmv2` 對齊。

完成後：
- 之前 `c26d7e0bf` 的 hardening throw 應該變成多餘（switch 收斂了所有可能性），可以保留作 defense-in-depth，也可以刪。建議保留並加註「by exhaustive check this branch is unreachable」。
- `packages/provider-codex/src/convert.test.ts` 既有 14 個測試必須照通。
- 加新 test 覆蓋 `fromLmv2` 對各 raw 形狀的收斂結果。

## 紀律（請嚴格遵守）

1. **9 層 system 架構契約** — system prompt 的 9 層 invariant 不可被任何 refactor 動到。compaction 也只能動 dialog 層。
2. **AGENTS.md 第一條「禁止靜默 fallback」** — `fromLmv2` 遇到無法收斂的 raw 必須 throw，不能塞 `kind: "unknown"` 兜底。
3. **行為不變** — 這階段只動型別與 dispatch 機制，AI 看到的請求 byte-level 應該完全一致。請用既有 test + 手動 diff 驗證 outbound payload 沒變化。
4. **不更動 AI SDK 版本** — `package.json` 凍結在當前版本，避免 upstream 型別 drift 干擾這次工作。
5. **不要動 opencode-runtime / opencode-beta**。所有改動都在 main repo。
6. **commit 紀律**：階段 0 用 1 個 commit 完成（小 PR 哲學）。Commit message 標 `refactor(protocol): introduce OcToolResultOutput union (lmv2 phase 0)`。

## 環境

- 主 repo：`/home/pkcs12/projects/opencode`（branch: `main`）
- 不要進 `opencode-beta`、`opencode-worktrees`
- `bun test packages/provider-codex/src/convert.test.ts` 驗證 14 個測試
- daemon 重啟用 `system-manager:restart_self`（不要自己 spawn / kill）

## 開工前先確認

- [ ] 讀完 `packages/provider-codex/src/convert.ts` 完整內容
- [ ] 讀完 `packages/opencode/src/session/message-v2.ts:680-742` 的 `toModelOutput`
- [ ] 讀完 `packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.ts:332-365`
- [ ] 讀過 commit `a7b2812c2` / `5bb6d319e` / `c26d7e0bf` 的 diff（`git show`），理解這次 bug 的修法路徑
- [ ] 同意上面六條紀律後再開始

如果中間發現「其實階段 0 牽連到階段 1 才能乾淨完成」，停下來回報，不要擅自擴大 scope。階段 0 不可包山包海。
