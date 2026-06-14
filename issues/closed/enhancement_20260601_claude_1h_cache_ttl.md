# Enhancement: claude provider 改用 1h prompt cache（官版用 1h、我們用 5min ephemeral）→ 解 cold-regime 的 write 浪費 + 慢 cold prefill + watchdog 壓力

- **Date**: 2026-06-01
- **Severity**: Medium-High（回報最高的單一改動之一:同時打到「cache write 浪費」「閒置後 cold 常發作」「大 cold prefill 撞 watchdog」三個痛點。零碎時間 / 常閒置的使用者影響最大）
- **Component**（**已更正**,原指錯檔)：
  - ~~`packages/opencode/src/provider/transform.ts`~~ ← 這是 **@ai-sdk anthropic 路徑,claude-cli 不走這條**。
  - 真正落點:`packages/provider-claude/src/convert.ts`（cache_control set 點,5 處)、`protocol.ts`（`CLAUDE_CACHE_TTL` SSOT + `extended-cache-ttl-2025-04-11` beta)、`headers.ts`（beta 接線)、`claude-context-policy.ts`（`CLAUDE_CACHE_TTL_MS` idle-gap)。
- **Status**: CLOSED — implemented by `801158deb` and deployed via `03e75e459`.
  - **§6 接線 caveat 已解除**:那 caveat 基於「走 @ai-sdk」的錯誤前提。native path 我們自組 body+headers 直送 api.anthropic.com,wire 全自控,跟官版做一樣的事即生效。
  - 官版實證更正:不是「ttl:1h 寫死 12+ 次」,而是 **computed ttl + gated**——`cli.js: if(ttl==="1h"&&ET()) push IWH`,即「用 1h 才送 beta header」,兩者綁定。我們用單一 `CLAUDE_CACHE_TTL` SSOT 鏡像此綁定。
  - **未驗(部署後必做)**:blast radius=每個 claude 請求,組合錯就全 400。部署後查 `claude-wire.jsonl` status=200、cache_creation 反映 1h、無 400;有 400 立即把 `CLAUDE_CACHE_TTL` 翻回 `undefined`。

---

## 1. 背景:Anthropic 兩種 cache TTL
| | 5min ephemeral | 1h cache（beta `ttl:"1h"`） |
|---|---|---|
| cache_write 計費 | 1.25x | 2x |
| 存活 | 5 分鐘 | 1 小時 |
| 適合 | 連續密集 | **零碎 / 常閒置** |

## 2. 證據:官版用 1h,我們用 5min
- **官版 claude-cli**（`refs/claude-code-npm/cli.js`）:`ttl:"1h"` 出現 12+ 次 → 穩定前綴用 1 小時快取。
- **我們**（`transform.ts:258`):`anthropic: { cacheControl: { type: "ephemeral" } }`,**無 `ttl` → 預設 5 分鐘**。

## 3. 為什麼 5min 對 cold-regime 是淨虧（cache 經濟學）
- `cache_read`=0.1x（命中、省）;`cache_write`=1.25x（**比沒快取的 1x 還貴**,是建快取的成本);`input`=1x。
- 5min cache:寫了 → 閒置 >5min → 過期 → 下次 resume **整包重寫(cold)**,那筆 1.25x write **從沒被讀到 = 純浪費** + 燒 quota + 慢。
- 1h cache:撐過大部分閒置 gap → resume 還讀得到(0.1x)→ 貴 write 被攤掉、不浪費。
- 損益:「被讀到 vs 過期浪費」的差,遠大於 1.25x→2x 的差。**對常閒置使用者,1h 幾乎一定划算。**

## 4. 連帶效益（三鳥一石）
1. **省 write 浪費 / quota**（上述）。
2. **cold 不常發作**:cache 活 1h → 閒置 5min–1h 回來不再 cold → resume 大多 warm。
3. **解 watchdog 壓力**:warm resume → prefill 瞬間(讀 cache)→ TTFT 快 → 不會撞「大 cold prefill 慢」的 idle timeout。
   - 連帶:`CLAUDE_CACHE_TTL_MS`（idle-gap 偵測,現 5min）也該配合改 ~1h → idle-gap 觸發的「cold resume 壓縮」會大幅減少（因為 cache 真的還在）。

## 5. 提議修法
1. `transform.ts` anthropic 分支:`cacheControl: { type: "ephemeral", ttl: "1h" }`(claude-cli/anthropic-only;其他 provider 不動)。
2. 確認 **beta header** 帶上（官版有送 extended-cache-ttl 類 beta header;查 `provider-claude` 送 request 的 headers）。
3. 同步把 `CLAUDE_CACHE_TTL_MS`（claude-context-policy.ts）從 5min 調整到對齊新 TTL。
4. **可做成 tweak config**(per-provider TTL),比照 `compaction_ctx_*`。

## 6. 接線可行性 caveat（必驗）
- (a) 我們走的 **AI SDK anthropic provider 的 `cacheControl` 吃不吃 `ttl` 欄位**?（官版直送 API,我們經 SDK——要確認 SDK 透傳。）
- (b) **beta header** 有沒有被帶上?（1h cache 是 beta，要對應 header,否則被忽略或報錯。）
- 官版有用 = API 支持;但我們這條 SDK/provider 路徑要實測。

## 7. 驗收
- wire 確認:改後的 request 帶 `ttl:"1h"` + beta header,Anthropic 回應 cache_creation 走 1h 計費。
- 行為:閒置 5–30 分鐘 resume → `cache_read` 不再歸零(warm)→ 無慢 cold prefill / 無 idle timeout。
- 成本:同 session 累積 cache_read/write 比改善（配合 telemetry fix,見 `bug_20260601_telemetry_cache_hit_ignores_write.md`）。

## 8. Related
- `bug_20260601_claude_upstream_stall_silent_timeout.md`（大 cold prefill 撞 watchdog,1h cache 可大幅緩解 cold 發生率）
- `bug_20260601_telemetry_cache_hit_ignores_write.md`（量化 read/write 淨效益,評估 1h 是否真划算的儀表）
