# Errors: tool-result presentation contract

本契約不引入新的使用者面錯誤碼（它是呈現層的資料保全，非業務邏輯）。下列為契約內部的異常/邊界處理與恢復策略。

## Error Catalogue

| code | 觸發條件 | 對 LLM 可見行為 | 恢復策略 | 責任層 |
|---|---|---|---|---|
| `E-PRESENT-1` | structuredContent JSON.stringify 拋例外（循環引用等） | output 退回原始 textParts join，metadata 標記 `presentationBackfill: { reason, error: "serialize_failed" }` | 不中斷工具結果；fail-soft 但顯式標記（非 silent） | composeMcpToolOutput |
| `E-PRESENT-2` | 回填後合併文字超出 truncation 預算被截斷 | output 為截斷版，metadata 帶既有 `outputPath` | LLM 走 HTTP blob 取完整（既有機制，非新增 fallback） | Truncate.output |
| `E-PRESENT-3` | 空殼但無 structuredContent（無可回填資料，TV8） | output 維持空殼原文，**不編造** | 交由 DD-6 行為防護注入 nudge；不在呈現層捏造資料 | composeMcpToolOutput / paralysis guard |

設計原則：

- **不捏造**：無資料可回填時，呈現層不得編造內容填空（違反天條的 silent fabrication）。空殼維持原樣，由行為層防護處理。
- **fail-soft 但顯式**：序列化失敗等異常退回原始輸出，但必在 metadata 留證據，不靜默吞掉。
- **不新增 fallback**：E-PRESENT-2 的 outputPath 是既有 truncation 機制，非本 plan 新增的 fallback。
