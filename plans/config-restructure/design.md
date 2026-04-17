# Design: Config Restructure

## Context

- Daemon 使用 `Config` namespace（[config.ts](../../packages/opencode/src/config/config.ts)）於 `state()` 載入 `~/.config/opencode/opencode.json`，JSONC 解析失敗時 throw `JsonError` 並將整份 text 嵌入 `message`
- HTTP 錯誤路徑：[server/app.ts:83-90](../../packages/opencode/src/server/app.ts#L83-L90) `onError` 將 `err.toObject()` 以 500 回傳，未過濾敏感欄位
- Webapp 側：`/global/config` fetch handler 某處直接將 500 body 輸出到 DOM（待 audit，候選 [packages/app/src/context/sdk.tsx](../../packages/app/src/context/sdk.tsx)）
- MCP 經驗證為 lazy 連線（[mcp/index.ts:199-264](../../packages/opencode/src/mcp/index.ts#L199-L264) + [session/resolve-tools.ts:221](../../packages/opencode/src/session/resolve-tools.ts#L221)），Phase 3 可行不需 preflight

## Goals / Non-Goals

**Goals:**
- 任何 config 解析失敗不導致 daemon 無法服務
- HTTP / webapp 層絕不外洩 raw config 原文
- 拆檔後單一 sub-file 壞掉只影響該 section
- 從 `accounts.json` 衍生 provider availability，省去手動維護 109 筆 denylist
- 所有 fallback 路徑符合 AGENTS.md 第一條（明確 log）

**Non-Goals:**
- 不重寫 `Config` namespace
- 不改 `Config.Info` 對外 schema
- 不做 hot-reload
- 不動 `accounts.json` 結構
- 不處理 `/global/config` 以外的 webapp fetch error 統一化

## Decisions

- **DD-1 LKG 快照位置 = `~/.local/state/opencode/lkg.json`**
  - Rationale：XDG `$XDG_STATE_HOME`（預設 `~/.local/state/`）為 derived state 標準位置，不污染 `~/.config/`；使用者明確選擇此路徑
  - Atomicity：寫入採 atomic rename（寫到 `.tmp` 再 `rename()`），避免部分寫入導致下次開機又壞

- **DD-2 User override 位置 = `providers.json`**
  - Rationale：配合 Phase 3 拆檔方向，provider 相關設定集中一處；使用者明確選擇
  - Migration：舊的 `opencode.json.disabled_providers` 向後相容讀取一個 release cycle，`log.info` 提示遷移

- **DD-3 Webapp fix 範圍 = 只 `/global/config`**
  - Rationale：先止血；全站 fetch error boundary 是 scope creep，另排 ticket
  - 實作：先 30 分鐘 audit 確認目前 render path，再動手修

- **DD-4 HTTP status 503 而非 500**
  - Rationale：config 暫時壞了屬於「service temporarily unavailable」，非 internal server error；operator 看監控可立即辨別

- **DD-5 `JsonError.message` 瘦身、debugSnippet 只進 daemon log**
  - Rationale：`toObject()` 會被序列化進 HTTP body，不得含原文；±3 行 context 足夠 daemon-side debug

- **DD-6 Section-level 錯誤隔離 = per sub-file try/catch**
  - Rationale：每個 sub-file 獨立 `loadFile()` + `JsonError`，其中一個壞不影響其他
  - 失敗處理：providers / mcp 空集 + log.warn；opencode.json 走 lkg（因為它含 boot-critical key）

- **DD-7 向後相容 = 一個 release cycle**
  - Rationale：避免使用者一次升級就炸；migration 腳本支援 dry-run；daemon log.info 提示遷移但不強制

## Data / State / Control Flow

### Phase 1：Parse 失敗防線

```
Request → Config.get() → state()
                         ├─ loadFile(opencode.json)
                         │   ├─ OK → write lkg (atomic)
                         │   └─ FAIL → log.warn + read lkg
                         │              ├─ lkg OK → return lkg config, set configStale:true
                         │              └─ lkg missing → throw JsonError(瘦身版)
                         └─ onError handler (app.ts)
                             ├─ ConfigJsonError → 503 { code, path, line, column, hint }
                             └─ log.error(debugSnippet)
```

### Phase 2：Provider availability 衍生

```
providerAvailability(id)
  ├─ check providers.json override → "disabled" if set
  ├─ check accounts.json has account(id) → "enabled"
  └─ else → "no-account" (treated as disabled, log.info)

legacy: opencode.json.disabled_providers → merged into override layer
```

### Phase 3：拆檔載入

```
state() → loadSplit({
  main: ~/.config/opencode/opencode.json,       // must succeed (or lkg)
  providers: ~/.config/opencode/providers.json, // section-isolated
  mcp: ~/.config/opencode/mcp.json              // lazy, section-isolated
})
  merged Config.Info  ← 舊對外形狀不變
```

## Risks / Trade-offs

- **Risk：LKG 快照過舊導致 silent drift** → Mitigation：每次成功載入都寫 lkg；log.warn 寫出「lkg timestamp、使用原因」；`configStale: true` 可被 UI 偵測並顯示 banner
- **Risk：Migration 腳本寫壞使用者 config** → Mitigation：`--dry-run` 先行、`.pre-split.bak` 備份、使用者確認 diff 後才寫回
- **Risk：Webapp audit 範圍誤判、改錯檔** → Mitigation：先 30 分鐘 grep 所有 `/global/config` 及 `innerText` / `innerHTML` 與 config 相關處；stop gate 要求審完才動手
- **Trade-off：向後相容讀舊單檔 vs 程式碼簡潔** → 選前者；一個 release cycle 後清除
- **Trade-off：section-level 隔離 vs 整體一致性** → 選前者；犧牲「config 是 atomic 一致狀態」換取「單檔壞不全倒」，因為使用者體感上 daemon 可用遠比一致性重要
- **Risk：`configStale: true` 旗標未被 UI 呈現** → Mitigation：Phase 1 webapp ErrorBoundary 同時處理 stale case，顯示「目前使用快照 config」提示

## Critical Files

- [packages/opencode/src/config/config.ts](../../packages/opencode/src/config/config.ts)
- [packages/opencode/src/server/app.ts](../../packages/opencode/src/server/app.ts)
- [packages/opencode/src/provider/availability.ts](../../packages/opencode/src/provider/availability.ts)（新）
- [packages/app/src/context/sdk.tsx](../../packages/app/src/context/sdk.tsx)（待 audit）
- [templates/opencode.json](../../templates/opencode.json) / [templates/providers.json](../../templates/providers.json) / [templates/mcp.json](../../templates/mcp.json)
- [scripts/migrate-disabled-providers.ts](../../scripts/migrate-disabled-providers.ts)（新）
- [scripts/migrate-config-split.ts](../../scripts/migrate-config-split.ts)（新）
- [specs/architecture.md](../../specs/architecture.md)
- [docs/events/2026-04-17_config_crash.md](../../docs/events/2026-04-17_config_crash.md)

## Supporting Docs (Optional)

- `plan.md` — 原始草案（本 plan 初稿）
- `docs/events/2026-04-17_config_crash.md` — 事故現場記錄
