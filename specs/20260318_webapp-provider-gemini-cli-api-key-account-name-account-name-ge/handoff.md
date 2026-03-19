# Handoff v2 — Account Manager Unified Refactor

## Execution Contract

本議題是 **Account Manager 統一重構**，不是單一 bugfix。7 個 Slice（0 + A-F）有嚴格的依賴順序。

## v1 → v2 核心差異

v1 有 5 個未做的決策會卡住實作。v2 已全部做出明確決定：

| 決策 | v1 狀態 | v2 決定 |
|------|---------|---------|
| Service 架構 | 「Auth 擴展或新建」未定 | 新建 `AccountManager`（`account/manager.ts`） |
| Event Bus | 未涵蓋 | 使用 `packages/bus/` + typed account events |
| Mismatch guard | 「要 guard」未定行為 | 400 Bad Request + detail JSON |
| Session-local 持久化 | 未定 | Ephemeral in session context（記憶體） |
| Model-manager authority | 未定 | rename/remove/connect = global, selection = session-local |
| Deploy observable | 「timestamp/hash」未定 | SHA256 hash comparison in `webctl.sh` |
| Storage safety | 未涵蓋 | Write-ahead pattern（temp → rename → update memory） |
| Silent fallback | 未涵蓋 | Auth.set disclosure + daemon single-path + mutation validation |
| Provider hardcode | 未涵蓋 | Capability declaration in provider config |
| `family` 處置 | 無 | 立即完全消除（確認只是 provider 的 naming drift） |
| Account ID 設計 | 未涵蓋 | accountId = 使用者輸入的名稱，消除 parseProvider 反解析 |
| UX 約束 | 無 | 前臺 TUI admin panel / webapp model manager 運作流程不變（隱式優化） |

## Required Reads

1. `implementation-spec.md` — 7 Slice 完整定義
2. `design.md` — 所有架構決策與理由
3. `spec.md` — 12 項 requirements
4. `tasks.md` — execution checklist

## Slice Dependency Graph

```
Slice 0 (Service + Event Bus)        ← 必須最先完成
  ├── Slice A (Route Delegation)      ← depends: 0
  ├── Slice B (Silent Fallback)       ← depends: 0
  │     ↓ (A+B 可平行)
  ├── Slice C (CLI/TUI Convergence)   ← depends: 0, A
  ├── Slice D (Authority Unification) ← depends: 0
  │     ↓ (C+D 完成後)
  ├── Slice E (Surface Alignment)     ← depends: 0, C, D
  └── Slice F (Deploy + Legacy)       ← depends: A, E
```

## Build Entry Recommendation

### Phase 1: Foundation（Slice 0）
1. 新建 `account/manager.ts`
2. 實作 write-ahead `save()` pattern
3. 整合 event bus + typed events
4. 設定 TUI / SSE consumer
5. 建立 provider capability declaration

### Phase 2: Backend Convergence（Slice A + B 平行，再 C）
6. Route delegation + mismatch guard
7. Auth.set disclosure + daemon single-path + mutation validation
8. CLI/TUI convergence

### Phase 3: Frontend Convergence（Slice D + E）
9. Authority unification（session-local vs global active）
10. Surface alignment + console SSE sync

### Phase 4: Hardening（Slice F）
11. Deploy SHA256 gate automation
12. Account ID format hardening
13. `family` 完全消除（type exports / helpers / route path / storage key / 檔名）

## Stop Gates In Force

| Gate | 條件 | 影響 |
|------|------|------|
| Slice 0 未完成 | AccountManager 不存在 or event bus 未接 | A-F 全部不得開始 |
| Slice A 未完成 | Route 仍直接碰 storage | C 不得開始 |
| Route path 改 `:providerKey` | family 無外部依賴 | Slice F 直接執行，前端同步更新 |
| App/Console 合併 | 產品方向未確認 | 不在本計畫，需另開 spec |
| Daemon 全面廢除 | 需確認 daemon 是否整體有用 | Slice B stop gate |

## Execution-Ready Checklist

- [x] Implementation spec 已改為 v2 統一重構方向
- [x] 所有 v1 缺口已有對應 Slice 或決策
- [x] 所有決策已做，不需臨場判斷
- [x] tasks.md 可直接作為 execution checklist
- [x] Slice dependency graph 已明確
- [ ] idef0.json 已同步（待更新）
- [ ] grafcet.json 已同步（待更新）

## Anti-Patterns（Build Agent 禁止行為）

1. 不得跳過 Slice 0 直接做 A-F
2. 不得在 AccountManager 外新增 mutation 路徑
3. 不得新增 silent fallback（包括 daemon fallback、mutation noop）
4. 不得保留任何 `family` 概念的 code（已完全消除，不只是禁止新功能）
5. 不得在 route 內直接呼叫 `Account.*` mutation
6. 不得讓 mutation 不發 event
7. 不得讓 `save()` 失敗後 in-memory 已髒
8. 不得改變 TUI admin panel 或 webapp model manager 的使用者可見行為（隱式優化約束）
