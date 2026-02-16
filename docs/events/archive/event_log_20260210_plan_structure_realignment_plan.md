# Event: Structure Realignment Plan (cms → origin/dev)

Date: 2026-02-10
Status: In Progress

## 1. 目標與原則

### 1.1 目標

在不引入業務邏輯變更的前提下，將 `cms` 的專案結構逐步回復為與 `origin/dev` 一致，讓未來差異可被切成小型 patch 連續同化。

### 1.2 強制原則

- **Path-only first**：優先處理路徑與結構，不混入功能修正。
- **Small batch**：每批只處理單一主題，確保可 review / 可 rollback。
- **Git-history preserving**：檔案搬移盡量使用 `git mv`。
- **Proof gates**：每批必跑驗證（typecheck + targeted tests）。
- **Always-sync**：每批開始前先同步 `origin/dev` 最新狀態。

---

## 2. 現況摘要（2026-02-10）

- 目前分支：`cms`
- 主要結構差異：
  - `origin/dev` 仍有 `packages/opencode/*`
  - `cms` 核心在 repo root：`/home/pkcs12/opencode/src`, `/home/pkcs12/opencode/test`, `/home/pkcs12/opencode/templates`
- 差異量（概算）：
  - `src` 變動檔：~464
  - `test` 變動檔：~81
  - `templates` 變動檔：~324

---

## 3. 路徑映射（Target Mapping）

> 本映射是後續所有批次的唯一基準。

- `/home/pkcs12/opencode/src/**` → `/home/pkcs12/opencode/packages/opencode/src/**`
- `/home/pkcs12/opencode/test/**` → `/home/pkcs12/opencode/packages/opencode/test/**`
- `/home/pkcs12/opencode/templates/**` → **保留於 repo root（cms overlay）**

---

## 4. 分批遷移策略（無限資源版）

## Phase A — Tooling & Infra 路徑對齊（不搬核心檔案）

### Batch A1: scripts/tools/nix/docker path normalization

優先處理目前已觀測到的檔案：

- `/home/pkcs12/opencode/scripts/changelog.ts`
- `/home/pkcs12/opencode/scripts/publish.ts`
- `/home/pkcs12/opencode/scripts/generate.ts`
- `/home/pkcs12/opencode/scripts/sync-config.sh`
- `/home/pkcs12/opencode/scripts/docker-setup.sh`
- `/home/pkcs12/opencode/tools/octl.sh`
- `/home/pkcs12/opencode/Dockerfile.production`
- `/home/pkcs12/opencode/nix/opencode.nix`
- `/home/pkcs12/opencode/nix/node_modules.nix`

**規則**：

- 只改路徑字串與 `cwd`，不得更改功能流程。
- 若相容性需要，可暫時保留 fallback（新路徑優先、舊路徑兼容）。

## Phase B — Docs 對齊（純文件）

### Batch B1: contributor/debug docs path cleanup

- `/home/pkcs12/opencode/CONTRIBUTING.md`
- `/home/pkcs12/opencode/DEBUGLOG.md`
- 其他提及 `packages/opencode/src` 的維運文檔（逐批處理）

**規則**：

- 僅修正文檔路徑與命令示例。
- 不改技術結論與決策敘事。

## Phase C — 引入雙路徑相容層（短期）

### Batch C1: build/test command shim

- 在 script 層提供統一入口，短期允許「新舊路徑都可執行」。
- 目的是降低後續大搬移時的 CI/本地開發中斷風險。

## Phase D — 目錄回遷（使用 git mv，嚴禁混邏輯）

### Batch D1: templates（已調整策略）

- `templates` 為 cms 專屬 overlay，不與 `origin/dev` 強制同位。
- 目標：固定保留於 `/home/pkcs12/opencode/templates`，僅維護引用路徑正確。

### Batch D2: test

- `git mv /home/pkcs12/opencode/test → /home/pkcs12/opencode/packages/opencode/test`
- 修正測試指令與 fixture 路徑。

### Batch D3: src（最大批，拆子批）

先低風險子目錄，後高風險子目錄：

1. 低風險：`src/util`, `src/format`, `src/file`, `src/command`
2. 中風險：`src/global`, `src/config`, `src/tool`
3. 高風險最後：`src/provider`, `src/session`, `src/cli/cmd/tui`, `src/account`

---

## 5. 每批驗證 Gate（必跑）

每一批完成都要執行：

1. `bun run typecheck`
2. `bun test`（或至少受影響子集）
3. Path audit：確認變更只限路徑/搬移（人工檢查 diff）
4. 啟動 smoke（受影響批次）

若任何 gate 失敗：

- 停止下一批
- 做 RCA（記錄到 `docs/events/`）
- 修正後再繼續

---

## 6. 同化節奏（避免再次漂移）

每個工作循環固定順序：

1. 同步 `origin/dev`
2. 更新 divergence 報告
3. 執行一個小批次（A/B/C/D 擇一）
4. 過 gate
5. 更新 ledger（本文件 + processed commits）

建議頻率：每日 1 批（高風險批次可 2-3 日/批）。

---

## 7. Batch A1 實作藍圖（下一步直接可做）

## 7.1 目標

先把 scripts/tools/nix/docker 的舊路徑參照修正，建立後續搬移的穩定基線。

## 7.2 範圍

- 僅限下列檔案：
  - `/home/pkcs12/opencode/scripts/changelog.ts`
  - `/home/pkcs12/opencode/scripts/publish.ts`
  - `/home/pkcs12/opencode/scripts/generate.ts`
  - `/home/pkcs12/opencode/scripts/sync-config.sh`
  - `/home/pkcs12/opencode/scripts/docker-setup.sh`
  - `/home/pkcs12/opencode/tools/octl.sh`
  - `/home/pkcs12/opencode/Dockerfile.production`
  - `/home/pkcs12/opencode/nix/opencode.nix`
  - `/home/pkcs12/opencode/nix/node_modules.nix`

## 7.3 驗收標準

- 所有上述檔案不再硬編碼 `packages/opencode`（除非為相容 fallback，且需註解原因）。
- `bun run typecheck` 通過。
- 受影響 script 可正常執行基本 smoke。

---

## 8. 回滾策略

- 每批單獨 commit。
- 若發生回歸，僅 rollback 當前批次，不影響前批成果。
- 禁止在 rollback commit 中混入新改動。

---

## 9. 待辦清單（Roadmap Snapshot）

- [ ] Batch A1：Tooling path normalization
- [ ] Batch B1：Docs path cleanup
- [ ] Batch C1：雙路徑相容 shim
- [x] Batch D1：templates 保留 root（cms overlay）
- [ ] Batch D2：test 回遷
- [ ] Batch D3：src 分層回遷
