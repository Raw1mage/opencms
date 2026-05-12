---
name: codex-sidebar-focus-rca
description: VS Code Codex 側欄聚焦錯誤（command 'workbench.view.extension.codexViewContainer' not found）的根因與修復流程。當啟動 Codex 擴充發生該錯誤、需要快速定位與容錯修補時使用。
---

# Codex 側欄聚焦錯誤 RCA 與處置

## 症狀
- 啟動 Codex 擴充或執行「Open Codex Sidebar」時，出現：`command 'workbench.view.extension.codexViewContainer' not found`。

## 核心結論（RCA）
- 屬於啟動時序的競態：擴充在 `activate` 期間過早呼叫容器切換命令，VS Code 尚未完成容器命令註冊即被呼叫，導致找不到命令。
- 容器與檢視實際已在 `package.json` 以 contributes 方式定義：
  - `viewsContainers.activitybar[0].id = "codexViewContainer"`
  - `views.codexViewContainer[0].id = "chatgpt.sidebarView"`（webview）
- 問題點在於聚焦函式（例如 `$n()`）未檢查命令是否可用就直接呼叫。

## 快速檢查
1) 驗證容器貢獻點是否存在：
   - 找到 Codex 擴充安裝資料夾（Windows 預設：`%USERPROFILE%\.vscode\extensions\`）。
   - 打開對應擴充 `package.json`，確認上述 `viewsContainers` 與 `views` 條目。
2) 尋找聚焦程式碼：
   - 於已編譯檔（例如 `out/extension.js`）中搜尋 `workbench.view.extension.codexViewContainer` 與 ``${In.viewType}.focus``，確認先後順序。

## 推薦處置
- 設定層面（低風險、無需改檔）
  - 保持或設為 `chatgpt.openOnStartup = false`，避免啟動當下立即聚焦，待 UI 完整載入後再手動開啟。
- 程式層面（容錯修補）
  - 在聚焦函式中，先以 `vscode.commands.getCommands(true)` 檢查是否包含 `workbench.view.extension.codexViewContainer`，存在才呼叫；最後一律執行 ``${In.viewType}.focus``：

    範例（概念片段）：
    ```ts
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes('workbench.view.extension.codexViewContainer')) {
      await vscode.commands.executeCommand('workbench.view.extension.codexViewContainer');
    }
    await vscode.commands.executeCommand(`${In.viewType}.focus`);
    ```

  - 注意：擴充更新可能覆寫本機改動；如需長期解法，建議上游納入存在檢查或短暫重試/backoff。

## 驗證
- 重新載入 VS Code 視窗（`Developer: Reload Window`）。
- 再次開啟 Codex 側欄，應不再出現命令不存在錯誤。

## 回滾
- 若有修改檔案，先行備份，回寫備份即可復原。

## 備註
- 在 Windows + WSL 環境看到 `/tmp/codex-ipc/*.sock` 屬正常（Codex 可能在 WSL 內跑），與本問題無直接關聯。
