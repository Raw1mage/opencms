# 2026-05-11 - Gate span per port

## 需求

- Grafcet gate 不能只靠固定 `port span + 4U` 決定長度。
- 對於超過 2 ports 的 branch，gate 必須隨 port 數動態延長，避免 port 擠在一起，並保留足夠 input/output drop 間距給 stubs。

## 範圍(IN/OUT)

### IN

- 調整 `webapp/grafcet_renderer.py` 的 gate bounds 寬度公式。
- 依 `port_count` 對 multi-port gate 加入額外長度預算。
- 重新輸出 `specs/session/grafcet.debug.svg` 驗證效果。

### OUT

- 不修改 Grafcet JSON schema。
- 不更動 L3 routing topology 或 L5 compaction contract。

## 任務清單

- [x] 確認現況：gate 基本長度為 `port span + 4U`，stub bar 長度為固定 `2U`。
- [ ] 依 port 數調整 gate 長度公式。
- [ ] 重繪 `specs/session/grafcet.debug.svg` 並比較 diagnostics。
- [ ] 同步 architecture / validation 記錄。

## Debug Checkpoints

- Baseline：`div 12` 類型問題顯示 gate bar 過短時，ports 會擠在一起，連帶壓縮 input/output drop 與 stub 安排空間。
- Baseline：目前 gate 幾何在 L2 由 `gate_left = min(gate_xs) - 2`、`gate_right = max(gate_xs) + 2` 決定，本質是 `port span + 4U`。

## Key Decisions

- 使用者指定規則：`1 port span + 4U` 只夠 2-port branch；超過 2 ports 時，每多 1 個 port，gate 再延長 `3U`。
- 規則落在 L2 gate geometry，而不是更動 L1 semantic branch topology。
