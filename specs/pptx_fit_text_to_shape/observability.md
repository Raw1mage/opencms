# Observability: pptx_fit_text_to_shape

## Events

求解器與 CLI 為純函式 + 一次性 CLI 調用，無長運行進程。觀測點以**回應 envelope 欄位**為主（caller 可據此判斷）。

| Event | 觸發 | 載荷欄位 |
|---|---|---|
| `fit_solved` | solve_fit 成功回傳 | `shape_id`, `index`, `title_pt`, `desc_pt`, `limited_by`, `overflow`, `needed_in`, `box_h_in`, `est_lines` |
| `fit_box_too_small` | floor 仍溢出 | 同上 + `overflow=true`（誠實標記，非錯誤） |
| `fit_no_geometry` | geometry 無法解析 | `shape_id`, `index`, error code `PPTX_FIT_NO_GEOMETRY` |

## Metrics

caller-side 可彙總：

- `limited_by` 分布（height / width / cap）：高 width 比例提示「框普遍偏窄，設計需放寬」。
- `overflow=true` 計數：框太小事件頻率，回饋給版面設計。
- 採用字級 vs cap 的差距：若常達 cap，提示 cap 設太低。

## Logs

- CLI 失敗走既有 docxmcp stderr 慣例：`{code}: {message}`（沿用 `SurgeryError`）。
- 成功時 `--stdout` 輸出完整 envelope JSON（含上述欄位），無 fit 時與現行 set_text 輸出一致。

## Alerts

- 本 feature 無獨立 runtime alert（一次性 CLI）。
- 回歸守門：CI 跑 `tests/test_pptx_fit_solver.py` + e2e；任一失敗即阻擋（fail-fast，符合 G3 byte 相容 stop gate）。

## 度量一致性可觀測點（核心驗證）

- 關鍵不變量：solve_fit 內呼叫的 `_estimate_text_height_in` 與 `pptx_layout_lint` 走的是**同一函式**。
- 觀測法：TV5 度量一致性測試斷言「同一 shape/text/font_pt 下 solver needed_in == lint needed_in」。此測試綠 = 度量無漂移（FR 核心訴求達成）。
