# Spec: tool-result presentation contract

## Purpose

保證任何 MCP 工具的實際輸出都對 LLM 可見，杜絕「成功卻空殼」誘發的同回合語意等價呼叫跳針。把「MCP 工具結果 → LLM 可見 channel」收斂成單一可測的 presentation contract。

## Requirements

### Requirement: structuredContent 不得對 LLM 丟失

#### Scenario: 工具只回 structuredContent + 佔位 text

- **GIVEN** 一個 MCP 工具成功回傳（`isError` 非 true），`content[]` 僅含一行佔位文字（如 `ok=True; see structuredContent`），實體資料在 `structuredContent`
- **WHEN** presentation contract 組裝 LLM 可見 output
- **THEN** `structuredContent` 被序列化（JSON.stringify, 2-space）補進 output
- **AND** metadata 標記 `presentationBackfill: { reason, bytes }`
- **AND** LLM 可見 output 非空殼

#### Scenario: 工具正常回 text + structuredContent（雙給）

- **GIVEN** 工具回傳的 `content[].text` 已含可讀主體，且也帶 `structuredContent`
- **WHEN** 組裝 output
- **THEN** 以 text 為主，不觸發回填（output 非空殼，無 backfill 標記）

#### Scenario: 工具回 isError

- **GIVEN** 工具回傳 `isError === true`，帶 `structuredContent`（error 物件）
- **WHEN** 組裝 output
- **THEN** 不觸發 structuredContent 回填（錯誤路徑維持既有行為，error text 照原樣呈現）

### Requirement: 原生工具行為不變（INV-0）

#### Scenario: read/edit/bash 等原生工具

- **GIVEN** 一個原生工具（不走 MCP wrapper / 無 structuredContent channel）
- **WHEN** 它的結果被呈現給 LLM
- **THEN** 輸出與導入 presentation contract 前 byte-identical（契約只掛 MCP wrapper 路徑）

### Requirement: 回填仍受 truncation 預算約束

#### Scenario: 大型 structuredContent 回填

- **GIVEN** 回填後的合併文字超過 token 預算
- **WHEN** 過 `Truncate.output`
- **THEN** 截斷生效，metadata 帶 `outputPath`（既有機制），LLM 可走 HTTP blob 取完整
- **AND** 回填不繞過 truncation

### Requirement: 行為層第二道防護（語意等價讀取重試偵測）

#### Scenario: 連續換 response_format 仍空殼

- **GIVEN** 主代理對同工具同回合連續 N 次呼叫，args 僅 response_format 類欄位變動，且每次 output 仍空殼
- **WHEN** paralysis guard 評估
- **THEN** 注入 nudge 提示「換讀取策略 / HTTP blob」，不靜默放任跳針

## Acceptance Checks

- test-vectors.json 全部通過：純 text / 純 structured / resource / 混合 / 空殼回填 / isError 不回填。
- INV-0 baseline：原生工具呈現路徑測試 byte-identical。
- 回填發生時 metadata 必帶 `presentationBackfill`（可觀測，非 silent）。
- SYSTEM.md §6 措辭與現行 whitelist dedup 設計一致（runtime + templates 同步）。
