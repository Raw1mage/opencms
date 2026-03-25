# Tasks

## 1. Compaction 閾值 + 冷卻期（方案 A + B）

- [x] 1.1 擴展 `config.ts` 的 compaction schema，新增 `headroom: number` 和 `cooldownRounds: number` 欄位（含 defaults）
- [x] 1.2 修改 `compaction.ts:inspectBudget()` — 使用 `headroom`（default 8000）取代固定 `COMPACTION_BUFFER` 計算 usable
- [x] 1.3 新增 per-session `lastCompactionRound` tracking（在 `SessionCompaction` namespace Map 中）
- [x] 1.4 修改 `compaction.ts:isOverflow()` — 加入冷卻期判斷：`roundsSinceLastCompaction < cooldownRounds` 時返回 false
- [x] 1.5 新增 emergency compaction hard ceiling — 當 count >= (context - 2000) 時忽略冷卻期，強制觸發
- [x] 1.6 修改 `prompt.ts:854-866` — 在 overflow 檢查傳入 sessionID + currentRound，compaction create 前呼叫 recordCompaction()
- [~] 1.7 驗證 — 方案 A+B 已上線穩定運作，未觀察到異常；正式驗證併入日常觀測

## 2. Prefix-preserving compaction（方案 C）— 已取消

**取消原因**：大部分 LLM provider 已具備 remote cache，prefix-preserving 的 cache hit 效益被 provider-side cache 覆蓋。此外 SharedContext 在每次 subagent dispatch 時已做 context digest，進一步消減了本方案的必要性。剩餘 token 效率改進歸入 `specs/shared-context-structure`。

- [~] 2.1 取消
- [~] 2.2 取消
- [~] 2.3 取消
- [~] 2.4 取消
- [~] 2.5 取消
- [~] 2.6 取消

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

---

## Plan Closure — 2026-03-26

**狀態**：已關閉

**成果摘要**：
- 方案 A+B（compaction 閾值 + 冷卻期）：已上線，穩定運作
- 方案 C（prefix-preserving compaction）：取消，LLM remote cache + SharedContext digest 已覆蓋其價值
- 方案 D（system prompt 去冗餘）：已回滾，AGENTS.md 指令為行為錨點不可壓縮

**後續歸屬**：token 效率的進一步改進由 `specs/shared-context-structure` 承接（結構化知識空間 + subagent 注入）。
