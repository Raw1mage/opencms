# Design

## Context

- 現況中，`/provider` 透過 `ModelsDev.get()`、`Provider.list()`、`Account.listAll()` 建立 canonical provider universe，這其實是在聚合「觀測到的 provider key」，不是表達產品正式支援矩陣。
- repo 內已有 canonical family normalization，但缺少一份 repo-owned allowlist 來回答「誰有資格進入 provider list」。
- 多個 UI 路徑另外維護 provider label hardcode，造成產品名稱與可見性規則分散。

## Goals / Non-Goals

**Goals:**
- 建立 repo 內單一 canonical provider registry 作為正式支援 provider SSOT。
- 讓 backend/provider UI 從 registry 衍生 universe 與 label，而非從觀測值反推 universe。
- 保留 `models.dev` 做 enrichment，但把 universe authority 從外部資料收回 repo。

**Non-Goals:**
- 不把 runtime custom provider 執行能力拿掉。
- 不在本輪完整重做 provider runtime builder 或 account storage。
- 不把所有 provider 相關 hardcode 一次完全清空，只先收斂 list authority 與主要 label path。

## Decisions

- 新增 repo-owned canonical provider registry（建議放在 `packages/opencode/src/provider/`），內容明確列出目前 cms 正式支援的 canonical providers：`openai`、`claude-cli`、`google-api`、`gemini-cli`、`github-copilot`、`gmicloud`、`openrouter`、`vercel`、`gitlab`、`opencode`。
- `/provider` universe 改為先走 registry，再 overlay `accounts` / `connected providers` / `models.dev` / disabled state；觀測來源只能補狀態與模型，不可增列 provider。
- `canonical-family-source.ts` 改以 registry 為 allowlist gate；normalization 只做 key 正規化，不再負責決定 universe。
- UI label/visibility 應優先消費 registry metadata，逐步替換零散 hardcode。
- `github-copilot-enterprise` 保持 runtime/provider variant 身分，不進 canonical UI provider registry。

## Data / State / Control Flow

- Repo-owned registry defines canonical provider keys + labels + visibility metadata.
- `/provider` route reads registry keys as the only provider universe.
- Runtime/account/models sources overlay per-provider state:
  - `Account.listAll()` -> account count / active account / configured hints
  - `Provider.list()` -> connected/runtime provider state
  - `ModelsDev.get()` -> supported provider model and metadata enrichment
  - config disabled providers -> enabled flag projection
- App/TUI consume `/provider` and registry-derived labels, rather than re-deriving provider identity locally.

## Risks / Trade-offs

- 某些目前「剛好可見」但未被正式收錄的 provider 會在修正後消失 -> 這是刻意 fail-closed 行為，符合產品型 SSOT 目標。
- UI 若仍殘留 hardcode label，可能出現 registry 與局部顯示不一致 -> 先對齊主要 consuming path，後續可再做 label hardcode 清理。
- 初版正式支援集若漏列實際產品需要的 provider，會造成過度收斂 -> 以 stop gate 要求產品決策，不允許默默 fallback。

## Critical Files

- `packages/opencode/src/provider/canonical-family-source.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/server/routes/provider.ts`
- `packages/opencode/src/account/index.ts`
- `packages/app/src/hooks/use-providers.ts`
- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/pages/task-list/task-detail.tsx`
