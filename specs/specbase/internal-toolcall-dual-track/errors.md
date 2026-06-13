# Errors: specbase_internal-toolcall-dual-track

## Error Catalogue

| ID | Condition | Surfaced as | Handling |
| --- | --- | --- | --- |
| E-LIB-LOAD | `@specbase/lib`（submodule）未解析/未編入 binary | daemon 啟動或工具註冊期拋錯 | build/啟動期 fail-fast + 清楚訊息（指向 submodule 未 init / 未 bump）；不得靜默讓 specbase 工具消失 |
| E-DEP-MISSING | lib transitive 純 JS 相依（gray-matter/markdown-it）opencode 端缺 | bundle/compile 失敗 | T4 確保相依存在；CI build 即時擋下 |
| E-TOOL-HANDLER | native handler 呼叫 lib 函式拋例外（如 sqlite I/O、scope 無效） | tool result error（與 MCP 路徑等價的錯誤語義） | 包成工具錯誤回傳給 agent，不 crash daemon；保留 lib 原始錯誤訊息 |
| E-SCOPE-UNRESOLVED | ctx.repo/lang 無法解析（Instance context 缺） | tool result error | 回退到等價於現行 SPECBASE_TARGET_REPO 的預設（parity，DD-8）；記 warn |
| E-PARITY-DRIFT | native id 集合未涵蓋 agent 依賴的 specbase_* | parity 測試 T8 失敗 | 視為 release blocker；修 native 註冊直到 ⊇ |
| E-EXTERNAL-REGRESSION | `@specbase/mcp` 薄 adapter 重構後對外 listTools 變動 | G3 比對失敗 | 阻擋繼續；修到對外逐項一致 |
| E-DEPLOY-REBUILD | `system-manager:restart_self` rebuild 失敗 | restart_self 回傳 errorLogPath | 讀 errorLogPath 修正後重試，不繞過（G2） |
