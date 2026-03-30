# Design

## Context

`plans/codex-efficiency/` 與 `plans/aisdk-refactor/` 最終收斂到同一結論：codex provider 的正確演進方向不是另起一條 custom language-model / transport stack，而是保留 AI SDK Responses pipeline，並把 codex-specific 能力分配到兩個正式 extension seam：

1. `providerOptions` / request construction
2. `packages/opencode/src/plugin/codex.ts` fetch interceptor

這份 design 不是新的未完成規劃，而是把已 merge 的方向沉澱為正式架構參考。

## Merged Architectural Decisions

### DD-1: AI SDK Responses path is the authority

- `LLM.stream()` 仍走 AI SDK Responses model path。
- 不以 CUSTOM_LOADER 取代 AI SDK 的 schema validation、tool loop、lifecycle、provider metadata 流。
- codex provider 維護重點是 request shaping / transport adaptation，不是複製一套 model runtime。

### DD-2: Responsibility split = providerOptions first, interceptor second

**ProviderOptions 層負責：**
- 可由 AI SDK 正式支援並具型別語意的 Responses API 欄位
- 與 model capability / adapter 行為耦合的 request options

**Fetch interceptor 層負責：**
- auth / URL rewrite / header continuity
- AI SDK 不直接支援的 body augmentation
- transport adaptation（HTTP/WS）
- response-side continuity capture

此分層是 merged 後的核心維護規則。

### DD-3: Continuity features are runtime concerns, not prompt hacks

以下能力都被視為 runtime continuity contract，而不是 prompt trick：
- prompt cache identity
- turn-state continuity
- encrypted reasoning reuse
- previous-response / delta continuation
- server compaction / context management

後續維護應優先檢查 request body、headers、provider metadata、history replay，而不是從 prompt wording 猜測。

### DD-4: WebSocket / delta / compaction remain extension surfaces under the same contract

即使 WebSocket transport、incremental delta、server compaction 在歷史 plan 中有分階段規劃，它們的正式歸屬已明確：
- 都是 codex provider runtime extension
- 都必須留在 AI SDK pipeline 下方
- 都不得重新引入平行 orchestration stack

### DD-5: Cleanup is part of the architecture, not incidental debt work

merged 計畫不只是在「加功能」，也包含：
- 停止 CUSTOM_LOADER truth surface
- 消除重複 auth/plugin 邏輯
- 避免 codex-specific unsafe casts 回流
- 將 continuity state 拉回 per-session isolation

這些清理屬於正式架構邊界，未來不應輕易回退。

## Runtime Flow Summary

```text
User message
  -> session/llm.ts
    -> providerOptions construction
      -> AI SDK Responses adapter builds request body
        -> fetch(url, { body, headers })
          -> plugin/codex.ts fetch interceptor
             - auth / account headers
             - continuity headers
             - codex-specific body augmentation
             - transport adaptation (HTTP / future WS)
          -> response stream / provider metadata
    -> session history + continuity state update
```

## Boundaries That Must Stay Explicit

### 1. Protocol observation vs local implementation
- `specs/codex/protocol/whitepaper.md` 是 source-derived interoperability note。
- `specs/codex/provider_runtime/` 是 opencode 自己的正式實作策略。
- 不應把 observed official behavior 直接當作本地 normative contract；需要經過本地 fail-fast / safety / architecture 邊界轉譯。

### 2. No silent fallback
- 對於 transport / compaction / continuity feature 的不支援情況，必須保留顯式 degrade 與可觀測訊號。
- 不可用「默默退回預設值」掩蓋 feature 失效。

### 3. Per-session state isolation
- continuity state 必須綁 session / turn，而不是無界共享 module-global mutable singleton。
- 多 session 並行是 codex provider 維護必檢項目。

## Historical Inputs Preserved By This Package

- `plans/codex-efficiency/` 提供行為需求與效能目標
- `plans/aisdk-refactor/` 提供 AI SDK pipeline 分析、責任切分、死碼清理與 extension seam 定位

兩者現在應被視為 historical build packages；正式語意參考改以本 root 為主。
