# Spec: pptx_fit_text_to_shape

## Purpose

為 pptx authoring 提供「fit-to-shape 字級求解」：給定一個 shape 的框 w/h 與文字段落，反推「撐滿框高且不寬度超界的最大字級」並寫回，與 `pptx_layout_lint` 共用同一組度量，使產出定義上通過 lint。

## Requirements

### Requirement: 求解最大安全字級 (pptx_fit_text)

#### Scenario: 大框小字 → 放大到 fit
- **GIVEN** 一個 0.92in 高、2 段短文字（title + desc）的 shape，目前字級遠小於框可容納
- **WHEN** 呼叫 `pptx_fit_text(doc_dir, index, shape_id)`（預設 title_cap=18, desc_cap=13, floor=9, ratio=1.30）
- **THEN** 回傳的 desc_pt 顯著大於原小值，title_pt = min(round(desc_pt×1.30), 18)
- **AND** 字級寫回該 shape 的對應 role 段落
- **AND** 隨後 `pptx_layout_lint` 對該 shape 不觸發 `PPTX_LAYOUT_OVERFLOW`（ready）

#### Scenario: 窄框長文字 → 寬度受限
- **GIVEN** 一個窄框 + 一段較長文字（放大字級即 wrap 超出可用寬度，進而高度溢出）
- **WHEN** 呼叫 `pptx_fit_text`
- **THEN** 回傳 `limited_by: "width"`
- **AND** 採用字級不超過寬度容許值，套回後不溢出
- **AND** 不 silent fallback 成最小字假裝 fit（受限原因顯式回報）

#### Scenario: 框達 cap → cap 受限
- **GIVEN** 一個很大的框、短文字（floor..cap 全部都不溢出）
- **WHEN** 呼叫 `pptx_fit_text`
- **THEN** 採用 desc_pt = desc_cap，回傳 `limited_by: "cap"`（標明框其實能更大字但被 cap 擋住）

#### Scenario: 框太小 → 誠實回報 overflow
- **GIVEN** 一個極小框、長文字（floor 字級仍溢出）
- **WHEN** 呼叫 `pptx_fit_text`
- **THEN** 採用 desc_pt = floor，回傳 `overflow: true` + `limited_by`
- **AND** 不假裝成功（caller 得知「要 fit 需放寬框或減字」）

#### Scenario: 無法解析框幾何 → fail-fast
- **GIVEN** 一個 placeholder 在 slide/layout/master 鏈都無可解析 geometry 的 shape
- **WHEN** 呼叫 `pptx_fit_text`
- **THEN** 回傳明確錯誤（無法解析框幾何），不亂猜框大小

### Requirement: set_text fit 參數 (主修 B)

#### Scenario: fit="shape" 自動求解
- **GIVEN** 一個 set_text 呼叫帶 `fit="shape"`，文字含 title/desc role，未傳明確 size
- **WHEN** 執行
- **THEN** 工具自動依框反推 title/desc 字級並寫入（與 pptx_fit_text 同一求解器）

#### Scenario: 不帶 fit → byte 相容
- **GIVEN** 一個 set_text 呼叫不帶 `fit`、給明確 size
- **WHEN** 執行
- **THEN** 行為與本 spec 實作前逐 byte 一致（不回歸）

### Requirement: 雙入口求解一致

#### Scenario: 同一 shape，兩入口字級一致
- **GIVEN** 同一個 shape
- **WHEN** 分別用 `pptx_fit_text` 與 `set_text(fit="shape")` 求解
- **THEN** 兩者算出的 (title_pt, desc_pt) 一致（共用同一求解器）

### Requirement: 度量一致性（與 lint 共用）

#### Scenario: needed-height 一致
- **GIVEN** 同一 shape 同一文字同一字級
- **WHEN** 求解器估的 needed-height vs `pptx_layout_lint` 估的 needed-height
- **THEN** 兩者相等（求解器呼叫 lint 的同一個 `_estimate_text_height_in`，非平行實作）

## Acceptance Checks

1. FR §5 五項回歸測試全綠（見 test-vectors.json）。
2. 真檔 e2e：對一個已知溢出的 deck shape 跑 `pptx_fit_text` → `pptx_layout_lint` 該 shape ready=true（或誠實 overflow=true 當框真的太小）。
3. `set_text` 不帶 fit 的既有測試不回歸。
4. 求解器無自寫高度估算（grep 確認 import 自 `_pptx_layout_lint`）。
