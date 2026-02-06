#### 功能：修復 CLI 腳本相容性與 XDG 對齊

**需求**

- 修復 `config/opencode/bin/` 下的腳本因 `type: module` 導致的 `require is not defined` 錯誤。
- 全面對齊 XDG 標準路徑（Config, Data, State, Cache），移除 `~/.opencode` 硬編碼。
- 修正 Provider 命名對齊（`google` -> `google-api`），減少統計中的 `unknown` 標籤。

**範圍**

- IN：`config/opencode/bin/` 下的所有腳本（`opencode-status`, `opencode-check-health`, `debug-openai.js` 等）。
- OUT：不變動核心 `src/` 代碼，僅針對周邊工具。

**方法**

- 將腳本 Shebang 從 `#!/usr/bin/env node` 改為 `#!/usr/bin/env bun`。
- 使用 `os.homedir()` 結合標準 XDG 子路徑重構路徑變數。
- 在 `opencode-status` 中加入 Provider ID 轉換與標籤映射。

**任務**

1. [ ] 更新 `config/opencode/bin/opencode-status`：改用 bun、對齊 XDG、修正 Provider 命名。
2. [ ] 更新 `config/opencode/bin/opencode-check-health`：改用 bun、對齊 XDG。
3. [ ] 更新 `config/opencode/bin/opencode-check-ratelimit` 等其他腳本。
4. [ ] 驗證所有腳本執行是否恢復正常。

**待解問題**

- 無。
