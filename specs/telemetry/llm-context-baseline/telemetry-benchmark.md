# Telemetry Benchmark Plan

## Goal

- 將 Slice B 的 telemetry 從「有事件輸出」提升到「可比較 baseline/after」的 benchmark 基線，對應 MIAT `A113 Compare Benchmark Sessions`。

## Benchmark Session Patterns

### Benchmark 1 — Short Session

- **Purpose**: 量測短回合下固定 system prompt 稅。
- **Shape**:
  - 1 個 user request
  - 1 次 `LLM.stream()`
  - 無 compaction
  - 少量工具或無工具
- **Primary metrics**:
  - `finalSystemTokens`
  - `finalSystemChars`
  - `messageCount`
  - `finalSystemMessages`

### Benchmark 2 — Mid Session

- **Purpose**: 量測多輪對話與一般 tool usage 下的 round telemetry 穩定度。
- **Shape**:
  - 3~6 user/assistant rounds
  - 至少 1 次 tool call
  - 尚未進 compaction 或接近 compaction
- **Primary metrics**:
  - `inputTokens`
  - `outputTokens`
  - `cacheReadTokens`
  - `cacheWriteTokens`
  - `observedTokens`
  - `usableTokens`
  - `needsCompaction`

### Benchmark 3 — Long / Planning Session

- **Purpose**: 量測 planning-heavy / tool-heavy session 的 compaction 壓力與 prompt block 結構。
- **Shape**:
  - 多輪 planning / docs / tool usage
  - 可包含接近 compaction 或已觸發 compaction 的 session
- **Primary metrics**:
  - 第一次 compaction 輪次
  - 每輪 `observedTokens / usableTokens` 比例
  - prompt blocks 中最大 block 與其 token 佔比

## Baseline Capture Procedure

1. 對每個 benchmark session pattern，收集至少 1 組代表性實際 session。
2. 從 telemetry events 擷取：
   - `llm.prompt.telemetry`
   - `session.round.telemetry`
3. 為每組 session 生成一個 baseline record，至少包含：
   - session 類型
   - provider/model/account
   - system prompt token estimate
   - input/output/cache tokens
   - context limit / usable / observed
   - needsCompaction

## After Comparison Procedure

當後續做以下任一優化後，重跑相同 benchmark：

- enablement snapshot gating（已落地，可作為第一個 before/after 比較候選）
- `isSubagentSession()` 去重
- compaction prompt slimming
- prompt block compaction / throttling

比較項目：

- `finalSystemTokens` 下降幅度
- `observedTokens / usableTokens` 變化
- `needsCompaction` 出現頻率是否下降
- continuity / workflow contract 是否退化

## Evidence Format

每次 benchmark 結果至少記錄：

- `benchmark`: short | mid | long-planning
- `sessionID`
- `providerId`
- `modelId`
- `promptTelemetrySummary`
- `roundTelemetrySummary`
- `compactionStatus`
- `notes`

## Current Status

- Telemetry event emission 已完成（A111/A112）
- Benchmark capture procedure 已定義（A113）
- Telemetry persistence 已落地：`llm.prompt.telemetry` / `session.round.telemetry` 會透過 global subscriber 寫入 `RuntimeEventService`
- Baseline record builder 已落地：`TelemetryBenchmarkService.captureBaselineRecord()` 可由 persisted runtime events 生成 benchmark record
- 第一筆 baseline dataset 已完成擷取（short session pattern，於 focused validation 中驗證）
- enablement snapshot gating 已落地；後續只需補同場景 after-change benchmark record 即可完成首輪比較

## Validation

- Architecture Sync: Verified (No doc changes)
  - Basis: 本文件同步的是 telemetry benchmark 狀態與證據成熟度，未涉及長期 architecture contract 調整。
