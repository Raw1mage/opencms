# Event 2026-05-02 — AI Anomaly Alerting Research

## 需求

研究 Warroom AI 異常預警模組：常見 AI 異常偵測模型、需要資料、如何與 Loki 串接，最後如何串接 Email / LINE Bot 警報。

## Scope IN

- 模型族群比較。
- Warroom 現有 Loki evidence / feature mapping。
- `warroom-ai-anomaly-scorer` POC 架構。
- Email / LINE Bot notifier lifecycle。

## Scope OUT

- 不實作 runtime service。
- 不新增 token/secret。
- 不做自動封鎖或 destructive response。

## Key Decisions

- 先採 rule + rolling baseline，不先上深度學習。
- Isolation Forest 作為第二階段/第三階段的 unsupervised model。
- LLM 只做 triage summary 與通知文案，不做 primary detection。
- AI scorer 將 anomaly 結果 push 回 Loki，Grafana/Notifier 都讀 normalized `anomaly_alert`。

## Validation

- Research artifact: `docs/ops/ai-anomaly-alerting-research.md`.
- Plan: `plans/20260502_ai_anomaly_alerting_research/`.
- Architecture sync: `specs/architecture.md` updated with AI scorer and notifier boundary.
