# Lazy Loader 不再支援 system-manager app alias 展開

## 狀態

- Closed
- Priority: High
- Type: Regression / RCA

## 背景

使用者指出 lazy loader 以前可以用 MCP app / namespace alias 載入 `system-manager`，但本 session 測試時只支援 exact toolcall name。

## 觀察到的行為

- `tool_loader({ tools: ["system-manager"] })` 失敗，回報 tool 不存在。
- `tool_loader({ tools: ["restart_self", "system-manager.restart_self", "system-manager:restart_self"] })` 失敗，回報 tool 不存在。
- `tool_loader({ tools: ["system-manager_get_system_status", "system-manager_app_control", "system-manager_execute_command"] })` 成功。
- 成功載入後，`system-manager_get_system_status` 可正常呼叫。

## 預期行為

- lazy loader 應能接受 `system-manager` 這類 MCP app / namespace alias，並展開為該 app 已註冊 toolcalls。
- 若 app 存在但部分 toolcall 不存在，錯誤訊息應區分「app alias 無法展開」與「特定 toolcall 不存在」。

## RCA 問題

1. `tool_loader` 的 alias/app expansion 是否被移除、繞過或只在某些 prompt registry path 生效？
2. `enablement.json` 的 `mcp_apps[].name = "system-manager"` 與 `tools.system_manager_mcp[]` 是否仍被 loader runtime 使用？
3. loader 是否只查 exact tool registry，而沒有查 MCP app registry？
4. `system-manager` app 已啟用，但 `restart_self` 不在 enablement registry；這是 tool 遺漏、命名漂移，還是 restart tool 從未註冊到 MCP schema？

## 初步證據

- Runtime registry：`packages/opencode/src/session/prompt/enablement.json` 列出 `system-manager` app enabled，且列出多個 `system-manager_*` toolcalls。
- Template registry：`templates/prompts/enablement.json` 同步列出同樣 system-manager toolcalls。
- 實測：exact toolcall 可 lazy-load；app alias 不可 lazy-load。

## 建議調查路徑

1. 檢查 `tool_loader` runtime 對輸入名稱的 resolver：是否只走 tool name exact match。
2. 檢查 enablement registry 解析：`mcp_apps[].name` 是否建立 alias index。
3. 檢查 system-manager MCP schema：是否存在 rebuild/reinstall/restart self tool，以及 canonical 名稱。
4. 補 regression test：`tool_loader(["system-manager"])` 應展開並載入該 app toolcalls，或回傳可行 toolcall 建議。
5. 若 `restart_self` 是預期能力，補 registry + template + MCP schema 同步測試。

## 驗收條件

- 找出 app alias 展開退化的 root cause。
- 修復或明確定義 lazy loader 只支援 exact toolcall name 的 contract。
- 若修復，`tool_loader({ tools: ["system-manager"] })` 可載入 system-manager tool bundle。
- restart self 的合法 tool path 在 registry、template、runtime tool pool 中一致可見。

## RCA 結論（2026-06-05）

- `restart_self` tool 本體存在，canonical runtime id 是 `system-manager_restart_self`；live check `tool_loader({ tools: ["system-manager_restart_self"] })` 成功。
- 退化點在 `packages/opencode/src/tool/tool-loader.ts`：原本只對 `UnlockedTools.getAvailable()` 做 exact match，沒有 MCP app alias expansion，也沒有 `:` / `.` namespace normalization。
- `system-manager_restart_self` 也漏列於 runtime/template `enablement.json` 的 `system_manager_mcp`，使 registry-guided prompt 不提示正確 canonical id。

## Fix（2026-06-05）

- `tool_loader` 新增 alias resolver：
  - exact id 保持原行為。
  - `system-manager:restart_self` / `system-manager.restart_self` 正規化為 `system-manager_restart_self`。
  - `system-manager` 展開為所有 `system-manager_` tool ids。
  - 短名如 `restart_self` 僅在唯一 suffix match 時解析；多候選時明確標 ambiguous，不 silent fallback。
- Runtime + template enablement 清單補入 `system-manager_restart_self`。
- 回歸測試：`bun test packages/opencode/test/tool/tool-loader.test.ts` → 3 pass, 0 fail。
