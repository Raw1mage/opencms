# Observability: harness_paralysis-steer-provider-split

## Events

- `paralysis-recover: …injecting nudge`(既有 log)新增欄位 `providerClass` 與 `carrier`(ephemeral | persisted),以便分辨走了哪條路徑。
- claude ephemeral 注入沿用 `claude-proactive-reminder.injected` 風格 log:`paralysis-steer.ephemeral.injected { sessionID, step, detector }`。
- SS 持久化路徑維持現有 log 不變(INV-0)。

## Metrics

- `storeWrites` per steer:SL 應恆為 0,SS 應 >=1(測試斷言,亦可做 runtime 計數 sanity)。
- hard-halt 觸發次數(`ParalysisDetectedError`):分流前後分佈不應因 claude 改 ephemeral 而異常上升(R1 回歸訊號)。

## Signals

- 主要驗收訊號:claude session 中「你說得對 / 你提醒得對」開場頻率顯著下降(人工/抽樣觀測,RCA issue §11)。
- 反向訊號:codex session 跳針恢復率不得下降(INV-0 保證解藥不回歸)。
- 警訊:若 claude 路徑出現任何持久化 synthetic role:user paralysis nudge → 分流未生效。

## 驗收觀測

- M4 測試以 store spy 直接量 storeWrites,作為「不落地」的客觀證據。
- restart_self 後抽一個 claude session 觸發 paralysis,確認 session 歷史不含中文責備 user 輪。
