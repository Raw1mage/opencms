# Proposal: pptx_fit_text_to_shape

## Why

- `pptx_layout_lint` 能**偵測**文字溢出（回報「text needs ~0.9in but box is 0.67in」），但沒有對應的**求解**能力：把「給定框 w/h + 文字 → 反推不溢出的最大字級」內建。
- 結果是每個要做「text size fits to shape size」的呼叫端，都得自己手寫字級求解器（量框、估 wrap 行數、反推字級），而且因為估算度量跟 lint 內部不一致，必然來回踩坑。
- 活例（2026-06-21 aiguard C00 Breakout）：使用者要求「字應 fit 框」，呼叫端在 sandbox 手寫求解器，因寬度/行高估算跟 lint 的實際 wrap 算法對不上，來回修了 3 輪才 lint 過。這套邏輯做完即丟，下一個人還要重來。

## Original Requirement Wording (Baseline)

- "text size preferably fits to the shape size" — 大格不該配小字，字級應依框反推到撐滿框高且不溢出的最大值。
- 來源：`issues/fr_20260621_pptx_fit_text_to_shape_size.md`（docxmcp repo）。使用者本輪指示「完整實作（走 plan → code → 測試）」。

## Requirement Revision History

- 2026-06-21: initial draft created via plan-init.ts
- 2026-06-21: 依 FR 全文 + `_pptx_layout_lint.py` 偵查填入有效需求；確認求解器與 lint 共用 `_estimate_text_height_in()` 即定義上零來回。

## Effective Requirement Description

1. 新增 **求解能力**：給定一個 shape（框 w/h 由 lint 既有的 geometry 解析鏈取得）與其文字段落，反推「撐滿框高且不 wrap 超界的最大字級」，並寫回 shape。
2. 求解器**必須與 `pptx_layout_lint` 共用同一個 wrap/height 函式**（`_estimate_text_height_in`），使產出字級定義上一定通過 lint（零來回）。
3. 支援 **title / desc 雙角色比例**：標題與說明文字以可設定比例（預設 1.30）分別求解，避免兩者同字級。
4. **邊界誠實**：fit 有時受寬度而非高度限制（窄框 + 長文字，字一放大就 wrap 超界）。求解器回應必須標明 `limited_by: "width" | "height"`，而非默默給個小字假裝 fit。
5. 兩個入口共用同一求解器：
   - 主修 A：新增 `pptx_fit_text` 動作（顯式求解 + 寫回 + 回報採用值）。
   - 主修 B：`set_text` / batch `set_text` 加 `fit="shape"` 參數（不傳 size 時自動求解）。

## Scope

### IN
- 主修 A：`pptx_fit_text` 動作 — 量該 shape 的 w/h、讀現有段落、用 layout_lint 同一組度量反推最大 (title_pt, desc_pt)、寫回、回報採用值 + `limited_by`。
- 主修 B：`set_text` / batch `set_text` 的 `fit="shape"` 參數（自動求解；不傳則維持現行明確 size，byte 相容）。
- 共用求解器核心模組（二分搜尋字級，呼叫 `_estimate_text_height_in`）。
- MCP 註冊（`_mcp_registry.py`）：`pptx_fit_text` 動作 schema + `fit` 參數 schema。
- 回歸測試（FR §5 五項）+ 真檔 e2e（fit → `pptx_layout_lint` ready=true）。

### OUT
- 主修 C（公開 lint 度量常數到 tool description / metrics 欄位）：A/B 完成後再評估是否仍需要；本期不做（A/B 已讓呼叫端不必自算度量，C 的退路價值下降）。
- 變更 lint 的偵測門檻常數（`overflow_tol` / `line_factor` 等）— 維持現值，求解器讀同一組常數。
- 多欄位/多 placeholder 的版面重排、自動換框 — 只調字級，不動 geometry。

## Non-Goals

- 不追求像素級完美字級；目標是「定義上過 lint 的最大安全字級」，與 lint 度量一致即可。
- 不引入新的 wrap/height 估算邏輯；嚴禁複製一份平行度量（那正是 FR 要消滅的漂移源）。
- 不做 silent fallback：求解不出（框太小/文字太長）時回報受限原因，不偷給最小字假裝成功。

## Constraints

- **度量單一真實來源**：求解器與 lint 必須呼叫同一個 `_estimate_text_height_in` / `_insets_in` / `_visual_width_em`。不得各算各的。
- **byte 相容**：`set_text` 不帶 `fit` 時行為與現行逐 byte 一致。
- **OOXML 一律走 docxmcp 內部**：求解 + 寫回都在 `bin/` 內實作，禁止 caller-side 手算或手改 part。
- **fail fast**：受限情境顯式回報 `limited_by`，不 silent fallback（符合專案天條第 11 條）。

## What Changes

- 新增 `bin/_pptx_fit_solver.py`（求解器核心，import lint 度量函式）。
- 新增 `bin/pptx_fit_text.py`（CLI wrapper）。
- `bin/_pptx_surgery.py` / `bin/pptx_revise_set_text.py`（或對應 set_text 路徑）加 `fit` 參數分支。
- `bin/_mcp_registry.py`：註冊 `pptx_fit_text` + `fit` 參數。
- `tests/`：新增回歸測試。

## Capabilities

### New Capabilities
- `pptx_fit_text`：給 shape 反推並寫回最大安全字級，回報採用值 + `limited_by`。

### Modified Capabilities
- `set_text` / batch `set_text`：新增 `fit="shape"` 開關，自動求解字級；不傳 `fit` 時行為不變。

## Impact

- 受影響碼：`bin/_pptx_layout_lint.py`（可能小幅重構以暴露純函式給求解器共用，不改其偵測行為）、`bin/_pptx_surgery.py`、set_text CLI、`bin/_mcp_registry.py`。
- 受影響工具面：MCP 多一個 `pptx_fit_text` 動作；`set_text` 多一個可選參數。
- 文件：`specs/architecture.md` 的 pptx authoring 段落需補求解器與 lint 的度量共用關係。
- 呼叫端（如 aiguard）：可移除自寫的字級求解器，改呼叫 `pptx_fit_text` / `fit="shape"`。
