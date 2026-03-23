# Telemetry Validation Gates

## Goal

- 將 MIAT `A114 Check Validation Gates` 轉成 builder 可直接執行的 gate checklist，明確區分：
  - implementation present
  - telemetry observable
  - baseline capture ready
  - optimization comparison ready

## Gates

### Gate 1 — Event Emission Exists

**Pass criteria**

- `llm.prompt.telemetry` event 已在 `session/llm.ts` 發出
- `session.round.telemetry` event 已在 `session/processor.ts` 發出
- compaction budget 計算由共享 helper 提供，不是重複邏輯

**Current status**: pass

### Gate 2 — Focused Validation Passes

**Pass criteria**

- 針對 touched files 的 focused typecheck / validation 不報新增錯誤
- 必須把 repo-preexisting failures 與 slice-specific failures 分開記錄

**Current status**: pass

### Gate 3 — Benchmark Procedure Exists

**Pass criteria**

- benchmark session patterns 已定義
- baseline / after comparison procedure 已定義
- evidence format 已定義

**Current status**: pass

### Gate 4 — First Baseline Dataset Captured

**Pass criteria**

- 至少一組真實 telemetry event 被擷取並整理成 baseline record
- record 至少包含 short 或 mid session pattern 其中一種

**Current status**: pass

### Gate 5 — After-Change Comparison Ready

**Pass criteria**

- enablement snapshot gating 已落地，後續 prompt-reduction slice（例如 prompt compaction）可沿用同一 benchmark procedure 做 before/after 比較
- 目前尚缺第一筆 after-change benchmark evidence，因此 gate 僅屬 comparison-ready，未完成 comparison-captured

**Current status**: pending

## Builder Action Order

1. 不要跳過 Gate 4 就直接宣稱 benchmark 完成。
2. 第一批 telemetry event 已可被整理成 baseline record；下一步應進入第一個 prompt-reduction change。
3. baseline record 完成後，適合進入第一個 prompt-reduction change 並做 after-comparison。

## Validation

- Architecture Sync: Verified (No doc changes)
  - Basis: telemetry persistence、baseline record capture、enablement snapshot gating 屬既有 session/runtime telemetry slice 的實作細化，未改變 repo 長期 architecture 邊界。
