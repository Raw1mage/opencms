# Proposal

## Why

- `plans/codex-efficiency/` 與 `plans/aisdk-refactor/` 實際描述的是同一條 codex provider 演進主線：先盤點 OpenAI Responses API / AI SDK 架構缺口，再把高價值效能與 transport 能力收斂回 AI SDK path。
- 使用者已確認這兩個 plan 對應的工作都已實作並 merge，因此它們不再屬於 active `/plans/`，而應提升為 formalized `/specs/` 參考包。
- 合併後的 spec 需要同時保留兩類知識：
  1. 行為/需求面：prompt cache、sticky routing、encrypted reasoning、compression、delta、compaction。
  2. 架構/遷移面：停止 CUSTOM_LOADER、自 AI SDK providerOptions + fetch interceptor 擴充、dead code cleanup、state isolation。

## Original Requirement Wording (Baseline)

- "請擬定一個plan，把上述server side api支援、高價值效能優化功能都加入實作計畫中。原則上先實作在codex provider上。"
- "我在opencode上調用LLM一小時可燒掉一週用量，禍首就是因為沒優化。"
- "我想要 codex 的進階功能（incremental context, cache, compaction, encrypt）。"
- "AI SDK 顯然是一個很完整現成的一大包功能，直接離開它似乎太冒然了。"

## Effective Requirement Description

1. codex provider 必須回到 AI SDK 為主的 Responses API data path，不再維護平行的 CUSTOM_LOADER / bespoke transport stack。
2. codex provider 應啟用高價值 Responses API server-side 優化與 continuity 能力，包括 prompt cache、sticky routing、encrypted reasoning reuse、compression，以及與此相容的後續 delta/compaction 演進面。
3. 所有實作必須遵守 fail-fast / no silent fallback 原則；對於 server 不支援的能力，採顯式、可觀測的 degrade 路徑。
4. 這些工作已完成並 merge，因此本 package 的責任是保存 merged intent、runtime boundaries、validation focus 與後續演進切口。

## Scope

### IN

- codex provider 在 AI SDK path 上的 Responses API 對齊策略
- `providerOptions` 與 `plugin/codex.ts` fetch interceptor 的責任分層
- prompt cache / sticky routing / encrypted reasoning / compression 的 merged behavior
- WebSocket transport adapter、incremental delta、server compaction、context management 的 merged planning context 與後續 extension boundary
- dead code cleanup、unsafe cast cleanup、turn-state isolation 等架構整理成果

### OUT

- 非 codex provider 的全面推廣策略
- OpenAI upstream / AI SDK upstream 修改
- 客戶端 UI/admin 對這些能力的觀測介面
- 任何需要冒充官方 `x-codex-*` 非公開語意的設計

## What Changes

- 將 `plans/codex-efficiency/` 與 `plans/aisdk-refactor/` 提升並合併為單一語意化 spec root：`specs/codex_provider_runtime/`
- 保留行為需求、架構決策、handoff 與完成狀態，作為後續 codex provider 維護的正式參考包
- 將 `/plans/` 視為歷史執行包；未經使用者進一步指示，不在本步驟自動刪除原 plan 目錄

## Impact

- 後續 codex provider 維護不必再同時閱讀兩個已完成 plan 才能理解 merged behavior
- `/specs/` 擁有一個正式的 codex provider runtime 參考包，可與 `specs/codex-protocol/whitepaper.md` 形成「協定觀察 + 本地實作策略」的雙文件結構
- 降低 `/plans/` 目錄的語意混亂：active plan 與 completed formal spec 分工更清楚
