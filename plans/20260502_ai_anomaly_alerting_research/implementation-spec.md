# Warroom AI Anomaly Alerting Research Plan

## Goal

研究並規劃 Warroom 的 AI 異常預警模組：理解常見 AI/ML 異常偵測模型、需要的資料特徵、如何和 Loki 串接，以及如何進一步串接 Email / LINE Bot 警報。

## Scope IN

- 比較常見 anomaly detection 模型族群。
- 對照 Warroom 現有 Loki evidence 與 collector source registry。
- 設計 `warroom-ai-anomaly-scorer` POC 架構。
- 設計 alert lifecycle 與 Email / LINE Bot notifier 路線。

## Scope OUT

- 本輪不實作 AI scorer runtime。
- 本輪不新增通知 token、SMTP credential、LINE token。
- 本輪不做自動封鎖、停帳、刪檔等 destructive response。

## Recommended Direction

1. Phase 1: rule-based anomaly events pushed back to Loki.
2. Phase 2: rolling baseline using z-score / EWMA / median-MAD.
3. Phase 3: Isolation Forest on windowed feature table.
4. Phase 4: LLM-assisted triage for explanation and notification text only.

## Validation Plan

- Research artifact exists and maps models to data/features.
- Architecture document records the AI scorer / notifier boundaries.
- Event log records decisions, caveats, and recommended roadmap.
