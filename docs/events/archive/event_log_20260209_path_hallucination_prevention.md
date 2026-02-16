# Path Hallucination 預防措施

**日期**: 2026-02-09  
**相關 RCA**: event_20260209_path_hallucination_rca.md  
**優先級**: High  
**狀態**: Active (需通知所有 Agent)

---

## 1. 問題回顧

Agent 對 project base 路徑產生持續混淆，導致：
- 30+ 無效工具呼叫
- 用戶需多次糾正
- Session context 嚴重浪費
- 任務延遲完成

**根本原因**: CWD (虛擬路徑) vs Filesystem (實體路徑) 未區分

---

## 2. 預防規則 (必須遵守)

### Rule-1: 任務啟動時確認 CWD ✅

**執行時機**: 任何涉及 filesystem 操作的任務開始時

```bash
# 方案 A: 最可靠 (Python)
python3 -c "import os; print(f'CWD: {os.getcwd()}')"

# 方案 B: 備選 (pwd)
pwd
```

**預期輸出示例**:
```
CWD: /home/pkcs12/opencode
```

### Rule-2: 先問再做原則 ⚠️

**觸發條件**: 對路徑有 **任何** 不確定

**行動**:
1. **停止** 工具執行
2. **詢問用戶**: "Current working directory is `/home/pkcs12/opencode`?", yes/no, or correct path
3. **採信用戶答覆**, 不做後續驗證

**禁止行為**:
- ❌ 用 `ls`, `stat`, `find` 等工具去「驗證」用戶的路徑
- ❌ 假設 CWD 不變
- ❌ 無視用戶的明確糾正

### Rule-3: 工具失敗計數 🔴

**規則**: 同類操作失敗 **3 次以上**, 立即停下來問用戶

**示例**:
```
失敗 1: ls /path/to/file → OK
失敗 2: stat /path/to/file → ENOENT
失敗 3: find /path -name file → not found
→ 【STOP】詢問用戶, 而不是繼續用 Python/AWK/SED 等更複雜的方法
```

### Rule-4: 文件系統操作優先級

**優先順序** (可靠性遞減):

1. 🟢 **Python**: `os.path`, `pathlib`, `shutil` (最可靠, 支援虛擬路徑)
2. 🟡 **Shell + 正確 CWD**: `cd + cat`, `cp`, `ls` (需確認 CWD 無誤)
3. 🔴 **工具組合**: `stat`, `find`, `lsof` (容易被虛擬路徑坑)
4. 🔴 **假設 + 相對路徑**: 容易出錯

### Rule-5: 用戶糾正即刻生效 ✓

**規則**: 當用戶明確糾正路徑時

**行動**:
- 🟢 立即更新內部 context
- 🟢 採信新路徑, 無需驗證
- 🔴 **禁止**再用工具驗證用戶的說法

**示例對話**:

```
Agent: "Exploring /home/pkcs12/claude-code..."
[多次失敗]

User: "Actually, it's /home/pkcs12/opencode"

Agent-Bad: "Let me verify..." (執行更多工具)
Agent-Good: "Got it. Working with /home/pkcs12/opencode from now on."
[立即執行新路徑下的操作]
```

---

## 3. Subagent 驗證清單

當 Orchestrator 收到 Subagent 回報時，**必須抽查以下內容**:

- [ ] Subagent 報告的路徑與當前 CWD 一致
- [ ] Subagent 曾驗證 CWD (見 Rule-1)
- [ ] 文件/目錄狀態聲明與實際文件系統相符
- [ ] 若路徑報告有矛盾, 立即停止任務要求澄清

**抽查方式**:
```bash
# 快速驗證 Subagent 報告的路徑
ls /path/reported/by/subagent
stat /path/reported/by/subagent
```

如果結果與 Subagent 回報不符, **不信任該 Subagent 的其他路徑聲明**.

---

## 4. OpenCode 架構知識

### `.claude-code` 虛擬目錄

**what**: OpenCode 將 `.opencode/` 映射為 `.claude-code/` 以相容 Claude Code

**where**: 
- 虛擬路徑: `~/.claude-code/` (在 Claude Code session 中可見)
- 實體路徑: `/home/pkcs12/opencode/.opencode/` (filesystem 中的真實位置)

**implication**:
- Shell 命令 (`ls`, `git`) 可能看到虛擬路徑
- 文件系統工具 (`stat`, `cp`) 需要實體路徑
- Python `os.getcwd()` 返回實體 CWD

### `.opencode/` 內容

- Skills: `.opencode/skills/` → 所有動態加載的 skill 定義
- Configs: `.opencode/AGENTS.md` → Agent 憲法與 SOP
- 其他資源

---

## 5. 應急流程 (當發生路徑混淆時)

**徵兆**: 
- 同一路徑上工具結果不一致 (`ls` OK, `stat` 失敗)
- Agent 反覆嘗試 3+ 種工具
- 工具連續失敗

**應急步驟**:

1. **暫停** 所有 filesystem 操作
2. **執行診斷**: `python3 -c "import os; print(os.getcwd())"`
3. **詢問用戶**: "What's the correct base path for this task?"
4. **採信用戶**, 更新 context
5. **切換方案**: 改用 Python 文件操作 (Rule-4)
6. **恢復執行**

**不要**:
- ❌ 繼續用複雜工具組合 debug
- ❌ 假設工具輸出是正確的
- ❌ 忽視用戶的明確糾正

---

## 6. 教訓與反思

| 教訓 | 原因 | 預防措施 |
|------|------|---------|
| CWD 不等於 Filesystem path | OpenCode 虛擬路徑設計 | Rule-1: 啟動時確認 CWD |
| 過度信任工具輸出 | 工具本身有局限 | Rule-4: 優先使用 Python |
| 忽視用戶明確指示 | Agent 過度自主 | Rule-2: 先問再做 |
| 無限重試 debug | 缺少 stop condition | Rule-3: 3 次失敗停下問人 |
| Subagent 信息未驗證 | Orchestrator 信任不足 | 添加 Subagent 驗證清單 |

---

## 7. 檢查清單 (每次執行涉及文件操作的任務時)

任務開始:
- [ ] 執行 `python3 -c "import os; print(os.getcwd())"` 確認 CWD
- [ ] 在 session 開頭記錄確認的 CWD
- [ ] 將 CWD 告知用戶以便確認

任務執行中:
- [ ] 使用 Python 作為首選文件工具 (Rule-4)
- [ ] 文件操作失敗 ≥ 3 次時停下問人 (Rule-3)
- [ ] 用戶糾正路徑時立即採信 (Rule-5)

Subagent 協作:
- [ ] 驗證 Subagent 曾確認 CWD (Rule-1)
- [ ] 抽查 Subagent 報告的關鍵路徑 (Subagent 驗證清單)

---

**簽署**: OpenCode Technical Debt Review  
**生效日期**: 2026-02-09  
**更新日期**: 2026-02-09
