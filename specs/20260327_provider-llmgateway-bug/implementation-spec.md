# Implementation Spec

> Promotion Status: Promoted from `/plans/20260327_provider-llmgateway-bug` to `/specs/20260327_provider-llmgateway-bug` on 2026-03-28.

## Goal

- 建立 repo 內的 canonical provider registry 作為 provider list 的單一真相來源，明確列出目前 cms 正式支援的 provider，並讓 `/provider` 與 UI 僅從此 registry 決定 provider universe；`models.dev` 只負責注入既有 provider 的模型與 metadata 更新值。

## Scope

### IN

- 新增 canonical provider SSOT registry，定義目前 cms 正式支援 provider list
- 讓 backend `/provider` route 改以 registry 決定可顯示 provider universe
- 保留 `models.dev`、runtime connected providers、accounts 作為狀態/模型/metadata 補充來源，不再決定 universe
- 對齊 web/TUI 主要 provider label / selector consuming path 到同一份 registry
- 補測試與文件，固定 `llmgateway` 類外部 key 不再進入 provider list

### OUT

- 不重寫整個 provider runtime builder
- 不移除 runtime 對 custom provider / config provider 的執行能力
- 不在本輪重新設計 rotation3d 或 account schema
- 不把所有歷史 provider 特例一次清零，只處理 provider list authority boundary

## Assumptions

- 「正式支援集」以產品明確維護、應穩定出現在 UI 的 canonical providers 為準，而不是所有 runtime 可觀測 provider。
- 目前 cms 正式支援 provider list 以現有產品文案、UI labels、account-known providers 與 runtime 自建 providers 的交集為基準，初版包含：`openai`、`claude-cli`、`google-api`、`gemini-cli`、`github-copilot`、`gmicloud`、`openrouter`、`vercel`、`gitlab`、`opencode`。
- `github-copilot-enterprise` 屬 runtime / variant provider，不列為 UI canonical provider。
- 未列入 registry 的外部 provider（例如 `llmgateway`）仍可存在於 runtime/config，但不得自動進入 provider list。

## Stop Gates

- 若實作過程發現上述正式支援清單與既有產品需求衝突，必須停下來請使用者決策。
- 若某些 UI / API 路徑實際依賴「觀測型 provider universe」而非產品型 provider universe，必須停下來 re-plan 受影響範圍。
- 若需要新增或移除正式支援 provider 項目，屬產品決策 gate，不得自行擴張。

## Critical Files

- `packages/opencode/src/provider/canonical-family-source.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/server/routes/provider.ts`
- `packages/opencode/src/account/index.ts`
- `packages/app/src/hooks/use-providers.ts`
- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/pages/task-list/task-detail.tsx`
- `specs/architecture.md`
- `docs/events/event_20260327_provider_list_llmgateway_rca.md`

## Structured Execution Phases

- Phase 1: Introduce a canonical provider registry that explicitly defines the cms-supported provider universe and its product metadata.
- Phase 2: Refactor backend provider list assembly so `/provider` starts from the registry and only overlays runtime/models/accounts state onto allowed providers.
- Phase 3: Align app/TUI consuming paths and labels to the registry, add regression tests for unsupported external providers, and sync docs.

## Validation

- Run targeted backend tests covering canonical provider row assembly and `/provider` list behavior.
- Run targeted app tests or typechecks for provider-consuming hooks/components.
- Verify an unsupported provider key injected via config/models data does not appear in `/provider` response or UI provider list.
- Verify all supported registry providers still appear with stable labels and expected enabled/configured state projection.

## Handoff

- Build agent must read this spec first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md / handoff.md before coding.
- Build agent must materialize runtime todo from tasks.md and preserve planner task naming.
- Build agent must prefer delegation-first execution when the task slice can be safely handed off.
