# Config Restructure — opencode.json 拆檔與防線

版本：2026-04-17 rev1
狀態：草案，待使用者確認後進入 Phase 1

---

## 一、背景

2026-04-17 出現事故：`~/.config/opencode/opencode.json` 檔尾被誤 append 了 `script` 6 bytes，觸發 JSONC parse error。Webapp 在畫面上直接渲染整份 10878 bytes 的 raw config text + error tail，形成「密密麻麻的 crash 畫面」（見 [docs/events/2026-04-17_config_crash.md] 若後補）。

事故暴露三個問題：

1. **Parse 失敗缺防線**：[config.ts:1644](../../packages/opencode/src/config/config.ts#L1644) 把整份原始 text 塞進 error message；[server/app.ts:89](../../packages/opencode/src/server/app.ts#L89) `onError` 原樣 JSON 回傳；webapp 某處把 500 body 當 text 丟進 DOM。三層都沒把關。
2. **opencode.json 責任過重**：單檔集中管 `provider` 覆寫、109 筆 `disabled_providers` denylist、6 個 `mcp` server 定義、`permissionMode`、`plugin` — 任何一段壞掉整個 daemon 無法啟動。
3. **109 筆 disabled_providers 手動維護成本高**：使用者已有 `accounts.json`，provider 有沒有帳號是可以自動推導的，不該手 key。

本計畫處理這三項。**不**重寫 config loader 機制；僅在現有 `Config` namespace 上增量擴充與拆檔。

---

## 二、目標

1. Config parse 失敗時，daemon 以「上次成功快照」繼續運作，webapp 顯示 friendly error，**絕不**把 raw config text 回傳到前端。
2. `opencode.json` 瘦身到 < 500 bytes，只保留真正 boot-critical 且低頻變更的 key。
3. `provider`、`mcp` 拆到各自檔案，單檔壞掉只影響該子系統，其他功能照常。
4. `disabled_providers` 可由 `accounts.json` 衍生，無帳號的 provider 預設 disabled；手動覆寫仍可用。

---

## 三、現況分析

### opencode.json 現有內容（10872 bytes）

| Key | 啟動必載？ | 變更頻率 | Bytes | Blast radius 於壞掉時 |
|---|---|---|---|---|
| `$schema` | 是（validator 用） | 幾乎不變 | 33 | 無 |
| `plugin` | 是（boot 時 import） | 低 | 2 | plugins 失效 |
| `permissionMode` | 是（第一個請求前） | 低 | 6 | 全 daemon |
| `provider` | 是（model resolve） | 中 | 3708 | 全 daemon（現況） |
| `disabled_providers` | 是（catalog filter） | 中—高 | 1462 | 全 daemon（現況） |
| `mcp` | **否**（connect 可 lazy） | 中 | 978 | 全 daemon（現況，但不該是） |

### Parse 失敗傳播路徑

```
loadFile(~/.config/opencode/opencode.json)
  └─ parseJsonc → errors.length > 0
      └─ throw new JsonError({ message: "--- JSONC Input ---\n" + FULL_TEXT + "--- Errors ---\n..." })
          └─ Config.get() 被呼叫的 request 全數 500
              └─ server/app.ts onError → c.json(err.toObject(), 500) — 包含 FULL_TEXT
                  └─ webapp fetch — 500 body 被某處 innerText 渲染
```

---

## 四、Phased 實作計畫

### Phase 1：Server-side 防線（最小改動）

目標：即使 config 壞掉，webapp 能看到清楚錯誤，不會看到原始 config 內容。

**檔案改動**

1. [packages/opencode/src/config/config.ts:1644](../../packages/opencode/src/config/config.ts#L1644)
   - `JsonError` 的 `message` 不再包含整份 text；改存 `line / column / errorCode / problemLine`（單行）。
   - 保留 `debugSnippet` optional 欄位存 ±3 行 context，只給 daemon log 用；**不**進 `toObject()`。

2. [packages/opencode/src/server/app.ts:83-90](../../packages/opencode/src/server/app.ts#L83-L90)
   - `ConfigJsonError` / `ConfigInvalidError` → status 503（不是 500，這是「config 暫時壞了」不是 internal error）。
   - Response body 改為 `{ code, path, line, column, hint }`，絕不含 `message` 全文。
   - `log.error` 印完整 debug snippet（僅 daemon-side，AGENTS.md 第一條：失敗明確報錯）。

3. [packages/opencode/src/config/config.ts:state()](../../packages/opencode/src/config/config.ts) — 新增 "last-known-good snapshot" 機制
   - 每次 `state()` 成功載入後，寫 `~/.config/opencode/.opencode.lkg.json`（atomic rename）。
   - 下一次啟動若 parse 失敗，讀 lkg 當 fallback，`log.warn` 並設旗標 `configStale: true`。
   - 不是靜默 fallback — log.warn 清楚寫出用了哪份 lkg、原檔錯在哪。符合 AGENTS.md 第一條。

4. Webapp 端：統一 fetch error boundary
   - 找出目前會把 500/503 body 直接 innerText 的那個路徑（需 audit；候選：`packages/app/src/context/sdk.tsx` 的 error handler 或 `global-error.tsx`）。
   - 改成 `ErrorBoundary` 呈現 `{ code, path, line, column, hint }`，絕不 render body 原文。

**驗證**

- 手動 append 垃圾字元到 `opencode.json` → daemon 啟動不會炸、webapp 看到 503 error card、daemon log 看得到詳細 snippet。
- lkg 機制：刪除 lkg → 首次壞掉會 500；保留 lkg → fallback 成功、`configStale: true` header 可見。

**工作量**：半天。

---

### Phase 2：disabled_providers 由 accounts.json 衍生

目標：移除 109 筆手動維護的 denylist，改由執行期推導。

**資料流**

```
accounts.json       ──┐
                      ├─→ providerAvailability(providerId) → enabled | disabled
user override (新 key) ┘
```

**檔案改動**

1. 新增 `packages/opencode/src/provider/availability.ts`
   - `export function providerAvailability(providerId: string): "enabled" | "disabled" | "no-account"`
   - 優先順序：user override > accounts.json 有帳號 > 無帳號 → no-account（預設視為 disabled）

2. Config loader 保留 `disabled_providers` 讀取能力（向後相容）
   - 若 `disabled_providers` 存在 → 視為「user override」合併到 availability。
   - `log.info` 提示建議 migrate（不是 warn，不是失敗）。

3. `scripts/migrate-disabled-providers.ts`
   - One-shot migration：讀 `opencode.json`，對每筆 disabled provider 檢查 accounts.json — 若已無帳號就可以刪掉（冗餘）；若還有帳號才保留為 override。
   - 乾跑模式 `--dry-run`；確認後才寫回。

**驗證**

- `bun run scripts/migrate-disabled-providers.ts --dry-run` 輸出「可刪 X 筆、保留 Y 筆 override」。
- 刪除整個 `disabled_providers` 後，`/provider` 列表應仍與之前一致（由 accounts 推導）。

**工作量**：1 天。

---

### Phase 3：拆檔 — mcp.json / providers.json

**目標檔案佈局**

```
~/.config/opencode/
├── opencode.json       # $schema, plugin, permissionMode （~100 bytes）
├── providers.json      # provider 覆寫 + 少量 disabled override
├── mcp.json            # 6 個 MCP server 定義
├── accounts.json       # （既有）
└── .opencode.lkg.json  # Phase 1 寫入的 snapshot
```

**載入順序（`state()` 內部）**

1. `opencode.json` — must succeed（壞掉才走 lkg）
2. `providers.json` — 若缺 / 壞掉 → 只影響 provider section，其他繼續載入
3. `mcp.json` — lazy；連線時才讀；壞掉 → log.warn、mcp 全 disable、主 UI 仍活

**檔案改動**

1. [packages/opencode/src/config/config.ts](../../packages/opencode/src/config/config.ts)
   - `loadFile` 改成單檔載入（已經是），新增 `loadSplit(paths: Record<section, path>)` 合併器。
   - 每個 sub-file 有獨立 `JsonError`，其中一個壞不影響其他 section。
   - Merge 順序維持現有 precedence（local > global），但加「section-level」概念。

2. [templates/](../../templates/)
   - 新增 `templates/opencode.json` / `providers.json` / `mcp.json` 範本。
   - Release 前檢查清單：`templates/**` 與 runtime 同步（AGENTS.md）。

3. Migration 腳本 `scripts/migrate-config-split.ts`
   - 讀舊 `opencode.json`，拆成 3 檔寫出。
   - 保留原檔備份 `.pre-split.bak`。
   - daemon 啟動時若偵測到舊格式 → log.info 提示執行 migration，繼續以舊格式運作（向後相容一版）。

**向後相容**

- 保留讀舊單檔 `opencode.json` 能力至少一個 release cycle。
- `Config.get()` 對外 API **完全不變** — 只是背後從多檔合併。

**驗證**

- 三檔都存在 → 合併結果與原單檔語意相等（unit test）。
- `mcp.json` 改成無效 JSON → daemon 啟動成功、mcp 全 disable、主功能正常。
- `providers.json` 改成無效 JSON → daemon 啟動成功、provider list 走 lkg 或空集、其他功能正常。

**工作量**：2 天（含 template sync + migration + tests + docs）。

---

## 五、不做的事（out of scope）

- **不**改 `Config.Info` schema 公開介面 — 對外 API 形狀維持不變。
- **不**動 `accounts.json` 結構。
- **不**把 `permissionMode` 拆出去 — 它是 boot-critical，留在主檔最輕便。
- **不**做 hot-reload — 目前 config 只在啟動時載入 / 透過 `Instance.dispose()` 重載，這次不改。

---

## 六、AGENTS.md 合規檢查

- **第零條（Plan 先行）**：本文件即 plan；Phase 1 可視為 hotfix（production-crash 防線）但仍列在 plan 中留痕。
- **第一條（禁止靜默 fallback）**：
  - Phase 1 lkg fallback 必須 `log.warn` 寫清楚「用了 lkg、原檔錯在哪」。
  - Phase 2 disabled_providers 衍生走 `log.info` 記錄「provider X 因無帳號 disabled」。
  - Phase 3 sub-file 載入失敗走 `log.warn` 記錄「哪個 section 失敗、用了什麼替代」。
- **Template 同步**：Phase 3 必須同步 `templates/**` 並記錄於 `docs/events/`。

---

## 七、依序排程

| Phase | 工作量 | 前置 | 可獨立 ship |
|---|---|---|---|
| 1 | 0.5 天 | 無 | ✅（hotfix 性質） |
| 2 | 1 天 | 無（可跟 Phase 1 平行） | ✅ |
| 3 | 2 天 | Phase 1 完成（lkg 機制已在） | ✅ |

建議排程：Phase 1 今天就做；Phase 2/3 取得確認後排入下一波。

---

## 八、開放問題

1. `lkg` 檔應該放在 `~/.config/opencode/` 還是 `~/.local/state/opencode/`？後者 XDG 上更乾淨。需決定。
2. Phase 2 `user override` 放回 `providers.json` 裡還是 `opencode.json` 的 `disabled_providers`？傾向前者（集中於 providers.json）。
3. Phase 3 拆檔的 JSON schema 要不要各寫一份 `$schema`？
4. Webapp 的 fetch error audit 範圍多廣？需決定一次修完還是只修 `/global/config` 這條路徑。

---

## 九、參考

- 事故現場：opencode.json 檔尾被 append `script`（2026-04-17）
- 相關 AGENTS.md 條款：第零條（plan）、第一條（禁止靜默 fallback）、Release 前檢查清單
- 相關檔案：
  - [packages/opencode/src/config/config.ts](../../packages/opencode/src/config/config.ts)
  - [packages/opencode/src/server/app.ts](../../packages/opencode/src/server/app.ts)
  - [packages/app/src/context/sdk.tsx](../../packages/app/src/context/sdk.tsx)（待 audit）
