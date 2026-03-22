# Tasks

## 1. Compaction 閾值 + 冷卻期（方案 A + B）

- [x] 1.1 擴展 `config.ts` 的 compaction schema，新增 `headroom: number` 和 `cooldownRounds: number` 欄位（含 defaults）
- [x] 1.2 修改 `compaction.ts:inspectBudget()` — 使用 `headroom`（default 8000）取代固定 `COMPACTION_BUFFER` 計算 usable
- [x] 1.3 新增 per-session `lastCompactionRound` tracking（在 `SessionCompaction` namespace Map 中）
- [x] 1.4 修改 `compaction.ts:isOverflow()` — 加入冷卻期判斷：`roundsSinceLastCompaction < cooldownRounds` 時返回 false
- [x] 1.5 新增 emergency compaction hard ceiling — 當 count >= (context - 2000) 時忽略冷卻期，強制觸發
- [x] 1.6 修改 `prompt.ts:854-866` — 在 overflow 檢查傳入 sessionID + currentRound，compaction create 前呼叫 recordCompaction()
- [ ] 1.7 驗證：啟動 session 觀察 telemetry，確認 compaction 頻率顯著下降

## 2. Prefix-preserving compaction（方案 C）

- [ ] 2.1 設計 message 分割邏輯 — 在 `compaction.ts:process()` 中將 input.messages 分為 `[old]` 和 `[recent]` 兩段
- [ ] 2.2 實作 recent messages 保留策略 — 從最新 message 往回累計 token，不超過 usable * 0.3，至少保留 2 個 user-assistant turns
- [ ] 2.3 修改 summary 生成 — summary prompt 仍收到所有 old messages，但 summary message 插在 old messages 位置
- [ ] 2.4 修改 compaction 後的 message 結構 — 確保 `[system] [summary] [recent unchanged]` 的排列
- [ ] 2.5 確保 `summary: true` 標記正確，後續 compaction 的 prune 和 break 邏輯不受影響
- [ ] 2.6 驗證：compaction 後的第一個 round cacheReadTokens > 0

## 3. System prompt 去冗餘（方案 D）— 已回滾

精簡版造成 LLM 行為品質下降（question tool 失靈、語言切換異常、continuation 停頓），全部回滾至原始版本。

**教訓**：AGENTS.md 可以去除與 SYSTEM.md 真正重複的段落，但不可精簡、改寫或壓縮獨特指令。每條指令都經過長期調校，措辭本身就是行為錨點。

- [x] 3.1 逐行分析三份文件重複內容，建立對照表
- [~] 3.2 精簡 Global AGENTS.md — 已回滾（87% reduction 太激進，造成行為退化）
- [~] 3.3 精簡 Project AGENTS.md — 已回滾（72% reduction 太激進，造成行為退化）
- [~] 3.4 檢查 SYSTEM.md — 未動
- [~] 3.5 同步 templates/AGENTS.md — 已隨回滾恢復原始版本
- [~] 3.6 驗證 — 不適用（已回滾）
- [~] 3.7 驗證 — 不適用（已回滾）
