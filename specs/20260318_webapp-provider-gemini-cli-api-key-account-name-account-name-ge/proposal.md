# Proposal v2 — Account Manager Unified Refactor

## UX 約束

本次重構對使用者而言是**隱式優化**。TUI admin panel 和 webapp model manager 的前臺運作流程必須維持不變。

## Why

現有「帳號管理」不是單一系統，而是至少 **7 條獨立演化路徑**疊在一起，且缺少一個統一的 service layer 與跨 session 同步機制：

1. `packages/app` connect dialog — onboarding/connect
2. `packages/console` BYOK workspace provider section — credential management
3. CLI / TUI admin / settings accounts — direct `Account.*` mutation
4. Server routes — partial delegation to Auth, partial direct storage mutation
5. `webctl.sh` / runtime frontend deploy verification
6. `Auth.set` — silent account reuse / token dedup（使用者不知道帳號被合併）
7. `UserDaemonManager` — daemon call + silent fallback to direct mutation（雙路徑）

## Problem Statement（v2 擴展）

v1 只處理了名詞不一致與 presentation drift。交叉比對原始碼後，發現以下根本性缺口：

1. **Event Bus 完全缺失**：帳號 mutation（add/remove/update/setActive）沒有任何 event notification。一個 context 改了帳號，其他 session / daemon / TUI 不知道。這是已知 ghost responses bug 的 root cause。
2. **Silent Fallback 違反天條**：
   - `Auth.set` 對相同 API key 或 OAuth token 靜默更新既有帳號
   - `UserDaemonManager` daemon 呼叫失敗 → 靜默 fallback 到 direct mutation
   - `Account.remove/setActive` 對不存在的目標靜默 noop
3. **Storage 一致性風險**：先改 `_storage` in-memory 再 `save()` to disk；若 save 失敗，in-memory 已髒
4. **Hardcoded provider 邏輯散落**：`gemini-cli` subscription bypass、auto-switch、projectId parsing 散在 auth/dialog/account 各層
5. **Account ID greedy regex**：`parseProvider()` 用 `/^(.+)-(api|subscription)-/`，對複合 ID 會錯誤解析
6. **Silent 自動遷移**：family key normalize、email repair 都是 silent mutation

## Effective Requirement Description

推翻 v1 的 5-Slice 計畫，重建為 **7-Slice（0 + A-F）統一重構方案**：

- **Slice 0（新）**：AccountManager Service Layer + Event Bus — 所有其他 Slice 的前置基礎
- **Slice A**：Route Service Delegation + Mismatch Guard
- **Slice B**：Silent Fallback Elimination
- **Slice C**：CLI/TUI Mutation Convergence
- **Slice D**：Active Account Authority Unification
- **Slice E**：App/Console Surface Contract Alignment
- **Slice F**：Deploy Verification + Legacy Cleanup + `family` 完全消除

## Scope

### IN

- AccountManager service layer 設計與 event bus contract
- Silent fallback 審計與消除
- 所有 v1 已涵蓋的範圍（名詞統一、route delegation、CLI/TUI 收斂、authority 分離、surface 對齊、deploy gate）
- Storage 寫入安全機制
- Hardcoded provider 邏輯收斂策略
- `family` 完全消除（已確認只是 provider 的 naming drift，無外部依賴）
- 消除 `parseProvider()` 反解析設計，改為所有 call site 攜帶 `providerKey`

### OUT

- 本 spec 階段不直接實作程式碼
- 不新增 provider 類型或 auth method
- 不合併 app/console 為單一 UI

## Success Criteria

- 任何帳號管理問題都能先透過單一 spec 判斷屬於哪個 Slice、哪個 contract、哪個驗證 gate
- 所有 v1 review 發現的缺口（event bus、silent fallback、storage safety、provider hardcode、ID format、silent migration）都有對應的 Slice 或決策
- Build agent 可依 tasks.md 直接執行，所有決策已做、不需再臨場判斷

## v1 → v2 變更摘要

| 項目 | v1 | v2 |
|------|----|----|
| Slices | A-E（5 個） | 0 + A-F（7 個） |
| Event Bus | 未涵蓋 | Slice 0 核心 |
| Silent Fallback | 未涵蓋 | Slice B 專門處理 |
| Service 架構決策 | 「Auth 擴展或新建」未定 | 明確：新建 AccountManager |
| Mismatch guard 語意 | 「要 guard」未定行為 | 明確：400 Bad Request |
| Session-local 持久化 | 未定 | 明確：session context ephemeral |
| Model-manager authority | 未定 | 明確：global mutation through service |
| Deploy observable | 「timestamp/hash」未定方法 | 明確：SHA256 hash comparison |
| `family` 處置 | 無 | 明確：立即完全消除（不做漸進淘汰） |
| Storage safety | 未涵蓋 | Slice 0 包含 write-ahead pattern |
| Provider hardcode | 未涵蓋 | Slice 0 provider capability declaration |
| Account ID 設計 | 未涵蓋 | 消除 parseProvider 反解析，改為 caller 必須攜帶 providerKey |
