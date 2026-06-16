# 子 agent 工作記憶治理盲區：熱 + 大 prompt 無 compaction 觸發

Status: OPEN (reported 2026-06-15；診斷完成，修法待設計——屬 compaction 核心，先不改)
Type: Bug Report / Architecture Gap
Severity: Medium-High（長命子 agent 工作記憶單調成長、全程無 compaction；唯一防線是 paralysis-halt 這個「撞牆才殺」鈍器）

關聯：
- `issues/bug_20260615_paralysis_guard_evaded_by_preface_perseveration.md`（同次事件的父 session 跳針）
- event `event_2026-06-15_rca-loop-paralysis-guard-counter-detector_fc5ke5`

---

## Symptom

子 session `ses_13487256affeLP1W41tAFsao2B`（某次 batch-fix coding subagent）：**121 個 assistant 回合、prompt 長到 ~231K、compaction 次數 = 0**（`summary=1` anchor count = 0）。
也就是它整個生命週期內工作記憶**從未被 compaction 治理**，一路單調成長到 231K 才結束。

## 根因：不是被排除，是觸發條件對子 agent 形同永不成立

DD-12（[prompt.ts:881-890](packages/opencode/src/session/prompt.ts#L881-L890)）名義上讓子 agent 走同樣的 compaction trigger（除了 manual）。但兩條 size 驅動路徑的**條件**子 agent 都碰不到：

1. **cache-aware（C→B，claude-cli 200K）需要「冷」**：
   `coldCacheBGate` 要 `promptTotal > 200K`（這趟 231K，**已滿足**）**且**冷
   （`cacheReadFraction < 0.5` 或 idle > 1h TTL）。子 agent 連續跑 → cache 一直熱
   （input 才 3884、total 231K → cache_read 佔 ~98%）→ 冷條件**永遠 false** → B-compaction 永不觸發。
   設計目的是「省冷重送成本」，熱跑的子 agent 沒有冷重送成本可省，所以正確地不壓——
   但也因此**永不壓**。
2. **overflow 需要逼近 window**：231K / 1M = 23% → `isOverflow` 永遠 false。

→ **compaction 治理本質是 cache 經濟學驅動，而子 agent 的存取模式（連續、熱、遠低於 window）剛好兩條都踩不到。**
母 session 之所以會壓，正因它**等子 agent 時 idle → 變冷**；子 agent 埋頭跑、永遠不冷 → 永遠不壓。
這個父子不對稱是真的。

## 連帶修正：子 agent 不是「context exhaustion」死的

父 session 全程敘述「batch-1 context exhaustion 17min」是 **confabulation**。子 session 的 `error_json` 是
**`ParalysisDetectedError`**（narrative detector，similarity 0.608，"Loop halted: 3 consecutive turns
repeated the same narrative EVEN AFTER a recovery nudge"）。231K/1M = 23%，**沒 exhaust**。子 agent 掉進
一模一樣的跳針，被既有 paralysis guard 正確 hard-halt。

→ 這次跳針**父子都中**：子 agent 被既有 guard 成功攔（halt）；父 agent 用「插門面 turn 重置 ladder」繞過
（已由上面關聯 issue 修掉）。

## 文件 hazard

[prompt.ts:535-537](packages/opencode/src/session/prompt.ts#L535-L537) 的 docstring 仍寫
「returns null when `session.parentID` is set so subagent sessions don't self-compact」——
這是**舊 legacy 行為的過時描述**，與現況 DD-12 矛盾，會讓人以為子 agent 完全不壓縮。應更正。

## 真正的 gap

唯一會對「熱但很大」的 prompt 出手的 size 觸發（overflow），門檻是 **window 相對值（1M）**，
對正常子 agent 高到永遠不會 fire。子 agent 工作記憶實際上只有 paralysis-halt 這個「撞牆才殺」鈍器在守，
**沒有任何「邊跑邊整理」的中途壓縮**。

## 建議方向（未實作；屬 compaction 核心）

1. 新增一條 **「熱 + 絕對大小超過 X」** 的 compaction 觸發——與 cache 冷熱無關、與 window 無關，
   讓長命子 agent 在中途也能壓一次。X 需校準（例如比 bCompactTokens 略高，避免短任務誤壓）。
2. 更正 [prompt.ts:535-537](packages/opencode/src/session/prompt.ts#L535-L537) 過時 docstring。
3. （可選）子 agent 死因回報如實化：把子 session 真實 `error_json`（此例 ParalysisDetectedError）
   帶進 PendingSubagentNotice，避免父 agent 自行 confabulate「context exhaustion」。

## 待辦

- [ ] 設計「熱-大」觸發門檻 + 驗證不會誤壓短子任務。
- [ ] 更正過時 docstring（純文件，可先做）。
- [ ] 子 agent 死因如實帶回父 notice。
