# Handoff: session-poll-cache

## Execution Contract

- 本 plan 走 **beta-workflow**：在 `beta/session-poll-cache` worktree 實作；完成且驗收通過後 fetch-back 到 `main`。禁止直接動 main 分支。
- 所有 phase 結束時寫一則 slice summary 到 `docs/events/event_2026-04-19_session-poll-cache.md`。
- 每個 `- [x]` 後必須跑 `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/session-poll-cache/`。
- 違反 AGENTS.md 第一條（靜默 fallback）直接 fail — 改動路徑必須有 log.warn 或 log.info 揭露「為什麼走 fallback」。

## Required Reads

1. [proposal.md](proposal.md) — why / scope / baseline metrics
2. [spec.md](spec.md) — requirements R-1..R-5 + AC-1..AC-6
3. [design.md](design.md) — DD-1..DD-9 + Risks
4. `packages/opencode/src/tool/task.ts:371-409` — bus bridge coverage
5. `packages/opencode/src/bus/index.ts:183-204` — `subscribeGlobal` 語意
6. `packages/opencode/src/session/message-v2.ts:1310-1340` — 寫入路徑的 bus publish 點
7. `/home/pkcs12/projects/opencode/AGENTS.md` 第零/第一/Bus 章節
8. `~/.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_tweaks_cfg.md`

## Stop Gates In Force

執行 Agent 必須在以下情況停下來問 user：

1. **Phase 2.1 盤點發現** bus bridge 遺漏寫入路徑 → 需要決定補 bridge 或把 cache 限縮到無遺漏的路徑。
2. **AC-1 基線量測** 發現 daemon 實際 CPU 不是 polling 造成（若 before-benchmark 也低 CPU），plan 前提失效 → 回報 user 調整 scope 或取消 plan。
3. **AC-3 invalidation correctness 失敗** → 可能 R-1 發生，需要 user 決定要擴大 bridge 還是縮小 cache 範圍。
4. **Rate limit 預設值 10 QPS/user/path** 在實際使用中誤擋了本機 webapp（AC 需要補實測）→ 需 user 決定調高 default 或加新豁免。
5. **觸發 `refactor` 模式條件**：若實作過程中發現 `Session.messages` 簽名必須破壞性改動、或 c4/architecture 結構變動超出 design.md 範圍。

## Execution-Ready Checklist

在開 beta-workflow 前確認：

- [ ] `.state.json.state` 已是 `planned`
- [ ] `tasks.md` 所有 phase 的 `- [ ]` 已就緒（無未填 `<placeholder>`）
- [ ] `design.md` Critical Files 已盤點完成
- [ ] beta branch 名稱：`beta/session-poll-cache`
- [ ] base branch：`main`
- [ ] fetch-back target：`main`
- [ ] docsWriteRepo：本 repo（`/home/pkcs12/projects/opencode`）
- [ ] 執行 agent 讀過 required reads

## Baseline Metrics (from 2026-04-19 observation)

Phase 6 必須先量測以下 before 基線並記錄：

- daemon `bun` 進程平均 CPU（目前觀察 ~44% 對應 2h wall / 54min CPU）
- `/session/{id}/message` p50 / p95 latency（目前觀察 48–61 ms）
- `/session/status` p50 latency（觀察 1 ms，應無明顯變化）

After 目標（AC-1/AC-2）：

- daemon 平均 CPU < 10%（相同 polling 壓力）
- `/message` p95 < 5 ms（cache hit）
- 304 比例 > 95%（當 session 無寫入）

## Phase 6 Ops Runbook

**Required before promoting the plan to `verified`.** AC-1 and AC-2 are
CPU / latency numbers that can only be honest when measured against a
live daemon. The test suite cannot substitute.

### 1. Prerequisites

- A daemon running the `beta/session-poll-cache` branch (fetch-back not
  yet required — the script can target any daemon reachable over HTTP).
- A session ID that the daemon knows about with ≥5 messages so cache
  hit / miss behavior is observable.
- The daemon's PID if you want CPU sampling (optional but recommended).

### 2. Baseline run — cache off

```bash
# Start daemon with OPENCODE_TWEAKS_PATH pointing to a temp file:
printf "session_cache_enabled=0\n" > /tmp/tweaks.baseline.cfg
OPENCODE_TWEAKS_PATH=/tmp/tweaks.baseline.cfg <your usual daemon start>

# In another terminal, 5-minute polling at 20 QPS:
bun run script/session-poll-bench.ts \
  --base=http://localhost:1080 \
  --session=ses_<id> \
  --qps=20 \
  --seconds=300 \
  --daemon-pid=<pid> \
  > /tmp/bench-baseline.json
```

Record from `/tmp/bench-baseline.json`:

- `latency_ms.p50`, `p95`
- `cpu_summary.avg_ticks_per_sample` → normalize to % by dividing by
  `(cpu_sample_sec * <USER_HZ>)` — `getconf CLK_TCK` gives USER_HZ
  (usually 100)

### 3. After run — cache on (default)

```bash
printf "" > /tmp/tweaks.cache.cfg   # empty = all defaults
OPENCODE_TWEAKS_PATH=/tmp/tweaks.cache.cfg <restart daemon>

bun run script/session-poll-bench.ts \
  --base=http://localhost:1080 \
  --session=ses_<id> \
  --qps=20 \
  --seconds=300 \
  --daemon-pid=<pid> \
  > /tmp/bench-cache.json
```

### 4. Verify AC-1 / AC-2

Compare both JSON files:

- **AC-1**: baseline avg CPU ≥30%; cache-on avg CPU <10%. If not, some
  other polling source is still hitting the daemon — stop those and retry.
- **AC-2**: in `/tmp/bench-cache.json`, `ratios.status_304` should be
  >0.95 because the bench echoes `If-None-Match` on every request after
  the first 200.

Copy the numbers into `docs/events/event_2026-04-19_session-poll-cache.md`
under a new "## Phase 6 ops result" section.

### 5. Optional — stress run (AC-4 live)

If you want a live confirmation on top of the unit test:

```bash
bun run script/session-poll-bench.ts \
  --base=http://localhost:1080 \
  --session=ses_<id> \
  --qps=100 \
  --seconds=60
```

`report.requests.by_status` should include a 429 entry; the bench
doesn't decode Retry-After itself but any 429 proves the middleware
fired. The unit test already asserts Retry-After header + body shape.

## Post-merge Follow-ups (not in this plan)

以下項目**不在**本 plan 範圍，完成後記錄於 handoff 供未來 plan 參考：

- Polling → SSE 推播遷移：本 plan 只做防禦層，真正治本是改推播。
- admin panel 連線追蹤 dashboard（user 之前問過）：若 `/cache/health` + middleware 改動後想加 `/connections` 端點，應開獨立 plan。
- 其他熱點路徑（`/session/status` 查 quota cache hit 狀態等）若後續發現同樣 polling 浪費，可沿用本 plan 模式（cache + ETag + rate-limit）複製到該路徑。
