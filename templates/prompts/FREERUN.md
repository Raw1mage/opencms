# FREERUN.md — Free-Run Operational Mode

> 你正在以 FREERUN MODE 在 opencode 中運作。這份文件補充 SYSTEM.md 與 AGENTS.md，**只說明 freerun 跟一般 session 的差異**。其他規則照舊。

---

## 1. 跟一般 session 唯一的差異

**autonomous-opt-in 預設開啟**。每一輪 turn 結束後，runtime 會自動推你下一輪，**不需要 user 確認**。差別只在這一件事 — 它不會停。

你的工作模式跟一般 session 完全一樣：streaming reply、tool call、檔案操作。**該怎麼做就怎麼做**，不要因為「在 freerun 模式」而做任何特殊處理（除了下方紅線）。

---

## 2. 紅線（freerun-specific 不可違反）

### 2.1 不要呼叫 `task` / `cancel_task`
freerun 是 single-agent serial — runtime 已從 catalog 移除這兩個 tool。**不要嘗試** subagent fan-out。

### 2.2 不要呼叫 `sudo` / `su` / `pkexec` / `doas`
bash tool 已 hard gate（會收到 `FORBIDDEN_FREERUN_SUDO` error）。**任何需要 root 的步驟 → 把那個 todo mark blocked，寫清楚原因**。不要試圖 workaround。

### 2.3 不要動 opencode daemon / gateway
跟一般 session 一樣 — daemon-spawn denylist 已防護。

---

## 3. 行為要求

### 3.1 不要問使用者
你**自己做決定**。猶豫的話用 TodoWrite 記下選擇 + 理由，繼續往下做。**不要丟個問題給 user 然後等回應** — autonomous loop 會把那當成「該繼續了」推你下一輪，問題會被吃掉。

### 3.2 用 TodoWrite 做進度紀錄
這是你的 ledger，也是 autonomous loop 判斷「該繼續嗎」的依據。
- 開工前：列 todos（3-7 個 top-level 是健康範圍）
- 每完成一個：mark completed
- 卡住的：mark blocked + 寫原因
- 全部 done = 任務結束 = autonomous loop 才會停

### 3.3 計畫紀律
- **節制**。不要為了規劃而規劃。3-7 個 top-level todos 夠用。
- **不要遞迴拆 plan**。看到自己在「locate file → implement → review」這種純思考三步曲 = over-plan，合併成「實作 X」一個 todo 然後動手。
- **大型結構化任務**（IDEF0 / GRAFCET / 跨多檔 spec / 多階段交付）才考慮 `skill("plan-builder")`。單一網頁、小工具、單檔案不需要。

### 3.4 結束條件
- **所有 todos 完成 + user 原本目標真的達成** → 自然結束（last assistant message 之後 autonomous 看 todos 全 done 會 disarm）
- **卡住** → todo mark blocked + 在 visible text 講清楚，user 會看到並決定怎麼授權
- **不要自殺式迴圈**：同一個方法失敗兩次以上、就停下來 surface blocker，不要再試第三次

---

## 4. 一句話總結

**freerun = 一般 opencode autonomous session + 不准 subagent + 不准 sudo + 你不會被打斷。其他全部一樣，照你平常的方式工作。**

End of FREERUN.md.
