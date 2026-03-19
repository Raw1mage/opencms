# Event: Account Manager Standardization Inventory

## 需求

- 檢討現有 account manager plan，完整盤點 account management 的多重標準來源。
- 產出可直接支撐新 branch 的統一重構方案，並以 **後端路由優先** 為第一階段。

## 範圍 (IN / OUT)

- **IN**:
  - `packages/opencode/src/server/routes/account.ts`
  - `packages/opencode/src/auth/index.ts`
  - `packages/opencode/src/account/index.ts`
  - `packages/app` / `packages/console` / CLI / TUI 的 account-related surfaces
  - `webctl.sh` / deploy verification gate
  - active spec artifacts under `specs/20260318_webapp-provider-gemini-cli-api-key-account-name-account-name-ge/`
- **OUT**:
  - 本次不直接實作新 branch 的大規模 route/UI 重構
  - ~~本次不移除所有 legacy `family` compatibility surface~~ → 已更新：本次計畫直接完全消除 family

## Inventory Summary

### Backend / Service / Storage

- `server/routes/account.ts`
  - listAll：回傳 canonical `providers` + legacy `families`
  - setActive：path 仍為 `:family`，內部語意逐步轉向 `providerKey`
  - remove：走 `Auth.remove(accountId)`
  - rename：仍直接 `Account.update`
  - login/quota：也仍存在 `family` compatibility surface
- `auth/index.ts`
  - `Auth.set` 已承擔 canonical provider resolve、API/OAuth dedup、collision resolution
  - `Auth.remove` 仍混合 providerId/accountId 語意
- `account/index.ts`
  - storage/repository 已偏 pure，但 schema / aliases / helpers 仍保留 `families` / `FamilyData` / `resolveFamily*`

### Presentation Surfaces

- `packages/app`
  - `dialog-connect-provider.tsx`：connect / onboarding
  - `settings-accounts.tsx`：list + set active
  - `dialog-select-model.tsx`：session-local selection + account actions（view/rename/remove/connect）
- `packages/console`
  - `routes/accounts.tsx`：list + set active
  - `workspace/[id]/provider-section.tsx`：BYOK/provider credential management
- CLI/TUI
  - `cli/cmd/accounts.tsx`：direct local account manager，仍直接使用 `Account.*`
  - `dialog-admin.tsx`：control-plane，混合 provider/account/model/provider enablement

## Standard Drift Matrix

1. **Naming drift** — `providerKey` vs `family`; `accountName` / `name` / `display name` / `label`
2. **Mutation drift** — add/connect 多數走 `Auth.set`; rename / setActive / remove 仍有 direct route/storage/CLI/TUI 變體
3. **Presentation drift** — `packages/app` 與 `packages/console` 角色相近但邊界未文件化
4. **Authority drift** — session-local selection vs global active account vs CLI/TUI immediate setActive 規則不一
5. **Verification drift** — web 修復可能只驗證 source build，未驗證 runtime bundle sync

## v1 Key Decisions（保留歷史）

1. active spec 升級為 Account Manager 標準統一化計畫。
2. 新 branch 第一優先採後端路由優先。
3. `family` 僅保留為 compatibility-only。
4. web account-related fix 的 deploy sync 視為功能驗證一部分。
5. route-first target contract 已定義。

---

## v2 Plan Rebuild（2026-03-18 Session 2）

### 觸發原因

交叉比對 spec 文件與實際原始碼後，發現 v1 有以下根本性缺口：

1. **Event Bus 完全缺失**：帳號 mutation 沒有任何 event notification，跨 session/daemon 無法同步。直接解釋已知 ghost responses bug。
2. **Silent Fallback 違反天條**：
   - `Auth.set` 靜默合併相同 key/token 的帳號
   - `UserDaemonManager` daemon 失敗 → 靜默 fallback 到 direct mutation
   - `Account.remove/setActive` 對不存在目標靜默 noop
3. **Storage 不安全**：先改 memory 再寫 disk，save 失敗 memory 已髒
4. **Hardcoded provider 邏輯散落**：gemini-cli subscription bypass / auto-switch / projectId parsing 散在 auth/dialog/account
5. **Account ID greedy regex**：`parseProvider()` 對複合 ID 錯誤解析
6. **5 個決策未做**：service 架構、mismatch guard 語意、session-local 持久化、model-manager authority、deploy observable

### v2 決策（全部已做）

| 決策 | 結論 |
|------|------|
| Service 架構 | 新建 `AccountManager`（`account/manager.ts`），wrap Auth + Account |
| Event Bus | 使用 `packages/bus/` + typed account events（connected/renamed/removed/active-changed） |
| Mismatch guard | 400 Bad Request + `{ error: "providerKey_mismatch", detail: {...} }` |
| Session-local | Ephemeral in session execution context（記憶體），session 結束即清除 |
| Model-manager authority | rename/remove/connect = global mutation; selection = session-local |
| Deploy observable | SHA256 hash comparison（`index.html`） |
| Storage safety | Write-ahead pattern（temp → rename → update memory） |
| Provider hardcode | Capability declaration in provider config |
| `family` 處置 | 立即完全消除（確認 `FamilyData = ProviderData`，純 naming drift，無外部依賴） |
| Account ID 設計 | accountId = 使用者輸入的 accountName（normalize 後），停止生成超長編碼 ID，消除 parseProvider 反解析 |

### v2 Slice 結構（7 Slices）

| Slice | 名稱 | 依賴 |
|-------|------|------|
| **0** | AccountManager Service + Event Bus | 無（基礎層） |
| **A** | Route Service Delegation + Mismatch Guard | 0 |
| **B** | Silent Fallback Elimination | 0 |
| **C** | CLI/TUI Mutation Convergence | 0, A |
| **D** | Active Account Authority Unification | 0 |
| **E** | App/Console Surface Alignment | 0, C, D |
| **F** | Deploy Verification + Legacy Cleanup | A, E |

### Spec Sync

所有 spec artifacts 已重建為 v2：

- `proposal.md` — 擴大問題陳述，v1→v2 變更對照表
- `spec.md` — 12 項 requirements（新增 R1-R4, R11-R12）
- `design.md` — 9 項架構決策（全部已做），dependency graph
- `implementation-spec.md` — 7 Slice 完整定義 + route contract table + validation
- `tasks.md` — 60+ 項 execution checklist
- `handoff.md` — 決策清單 + stop gates + anti-patterns
- `idef0.json` — 重建反映 Slice 0-F 結構
- `grafcet.json` — 重建反映新流程（含 divergence_and for parallel slices）

---

## v2.1 更新（2026-03-19）

### 變更摘要

1. **`family` 從漸進淘汰改為立即完全消除**：
   - 程式碼審計確認 `FamilyData = ProviderData`（literal type alias），`FAMILIES = PROVIDERS`
   - 所有 canonical provider 1:1 對應，唯一歷史例外 `google` 已拆分並 blocklisted
   - family 從來不是獨立抽象，只是 provider 的命名漂移
   - 消除範圍：type exports / helpers / route path / response field / storage key / 檔名

2. **新增 UX 不變約束（R14）**：
   - 本次重構對使用者而言是隱式優化
   - TUI admin panel 和 webapp model manager 前臺運作流程必須維持不變

3. **新增實作場地決策**：
   - 實作在 beta repo（opencode-beta）開新 branch 處理

### 受影響文件

- `design.md` — Decision 9 重寫、新增 UX 約束段落
- `implementation-spec.md` — Slice F F3 重寫、route path 全面更新、新增 UX 約束
- `spec.md` — R5/R12 重寫、新增 R14
- `tasks.md` — F.8-F.19 重寫（從 2 項擴展為 12 項）
- `handoff.md` — 決策表/stop gates/anti-patterns 更新
- `proposal.md` — Slice F 描述/scope/對照表更新、新增 UX 約束
- `idef0.json` — A5/A52 description、arr11 control label 更新
- `grafcet.json` — Step 9/11 action/condition 更新

## Remaining

- 完成 Slice 0 實作（AccountManager + Event Bus + Write-Ahead + Capabilities + Consumers）
- 完成 Slice A+B 實作（Route Delegation + Silent Fallback Elimination）
- 完成 Slice C 實作（CLI/TUI Convergence）
- 完成 Slice D+E 實作（Authority Unification + Surface Alignment）
- 完成 Slice F 實作（Deploy Gate + Family 完全消除 + Account ID 簡化）
- 實作場地：opencode-beta repo 新 branch

## Validation

- v1 inventory 已完成 framework-docs-first 盤點。
- v2 已交叉比對原始碼，所有已知缺口都有對應 Slice 或決策。
- v2.1 已更新所有 spec artifacts（10 份文件）反映 family 完全消除 + UX 不變約束。
- Architecture Sync: Verified (No doc changes)
  - 本次主要更新 specs 與 event inventory，尚未變更 runtime module boundary。
  - 下次進入 Slice 0 實作時，需同步更新 `specs/architecture.md`（AccountManager service layer + event bus contract）。
