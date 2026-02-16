# RCA: Session 路徑幻覺事件

- **日期**: 2026-02-09
- **嚴重度**: High — 大量 session context 浪費在無效的路徑探索
- **影響**: ~30+ 次無效工具呼叫、用戶體驗嚴重受損

---

## 1. 事件摘要

在執行 AGENTS.md symlink 重建與 skills 整合任務時，Agent 對 project base 路徑產生嚴重且持續的混淆，反覆在不存在的路徑上執行操作，直到用戶多次糾正才完成任務。

---

## 2. 時間線

| 階段 | 行為 | 問題 |
|------|------|------|
| 初始探索 | 派出 explore subagent | Subagent 回報 `.claude-code/` 不存在，但實際上是 opencode 的虛擬映射 |
| 路徑確認 | 反覆用 `ls`, `stat`, `find`, `python3` 交叉驗證 | `ls` 能列出但 `stat`/`cp`/`cat` 失敗，Agent 陷入 debug 迴圈 |
| 用戶糾正 #1 | 用戶說「目前的 project base 應該是 ~/claude-code/」 | Agent 沒有正確理解，繼續在錯誤路徑操作 |
| 用戶糾正 #2 | 用戶說「目前的 project base 是 opencode」 | Agent 開始搜尋 ~/opencode，但仍被工具輸出帶偏 |
| 用戶糾正 #3 | 用戶說「不存在 /home/pkcs12/claude-code」 | Agent 終於停下來，但仍無法解釋路徑不一致 |
| 最終執行 | 改用 Python `os.getcwd()` + `shutil` | 成功完成操作 |

---

## 3. 根本原因

### RC-1: 未區分「CWD 路徑」與「filesystem 實體路徑」

Claude Code session 的 CWD (`/home/pkcs12/claude-code`) 是一個由 session 環境設定的工作路徑。部分 shell 命令（`ls`, `git`）能透過 file descriptor 存取，但其他命令（`stat`, `cp`, `cat`）需要透過 filesystem path resolve，而該路徑在 filesystem namespace 中可能以不同名稱存在（如 `/home/pkcs12/opencode`）。

Agent 從未建立這個基本認知，導致後續所有操作都建立在錯誤假設上。

### RC-2: 過度信任工具輸出，忽略用戶明確指示

用戶 **三次** 明確指出正確路徑，但 Agent 每次都選擇用工具命令去「驗證」用戶的說法，而非直接採信。這違反了一個基本原則：**用戶對自己的環境比 Agent 更權威**。

### RC-3: 對 opencode `.claude-code` 虛擬目錄機制不熟悉

opencode 將 `.opencode/` 映射為 `.claude-code/` 以相容 Claude Code 的 skill 載入機制。這是 opencode 的架構設計，Agent 不知道這個機制，把它當成 filesystem 異常去 debug。

### RC-4: 陷入 Debug 迴圈，未及時止損

當 `ls` 能看到但 `stat` 看不到時，Agent 應該停下來問用戶，而不是用越來越多的工具（`find -inum`, `python os.stat`, `/proc/self/cwd`）試圖自行解謎。這嚴重浪費了 session context。

### RC-5: Explore subagent 回報的錯誤資訊未被質疑

初始 explore subagent 回報了多項錯誤資訊（如「~/.config/claude-code/ 目錄不存在」、「/refs/claude-code/skills 未發現」），Orchestrator 未加驗證就採信，導致後續方案建立在錯誤前提上。

---

## 4. 應學到的教訓

1. **先問再做**：對路徑有任何不確定，直接問用戶，不要花 20 次工具呼叫去 debug。
2. **用戶說的路徑就是正確路徑**：不要用工具去「驗證」用戶的明確指示。
3. **認識 opencode 的 `.claude-code` 映射機制**：`.opencode/` 的內容會被映射到 `.claude-code/` namespace。
4. **CWD 不等於 filesystem path**：session CWD 可能是虛擬的，Python `os.getcwd()` 是最可靠的。
5. **3 次工具失敗就該停下來問人**：不要無限重試。

---

## 5. 預防措施

- 任務開始前，用 `python3 -c "import os; print(os.getcwd())"` 確認真實 CWD
- 所有 filesystem 操作優先使用 Python (`shutil`, `os`) 而非 shell 命令
- 用戶糾正路徑時，立即採信並切換，不做額外驗證
- Subagent 回報的路徑資訊必須由 Orchestrator 抽查驗證
