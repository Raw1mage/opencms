# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read design.md for architectural decisions (DD-1 through DD-6)
- Build agent must read tasks.md and materialize runtime todo with IDEF0 numbering
- Step 0 must complete before any other Step
- Each Step (1-6) is independently deliverable after Step 0

## Required Reads

1. implementation-spec.md — scope, stop gates, critical files
2. design.md — four-layer architecture, decision table (DD-1 through DD-6)
3. spec.md — requirements with GIVEN/WHEN/THEN scenarios
4. tasks.md — execution checklist with IDEF0 references (A0-A7)
5. idef0.json — A0 context: functional decomposition (A1-A7, 7 activities)
6. grafcet.json — state machine: 4 flows (provision, install, UI CRUD, startup)

## Key Decisions (Summary)

| DD | Decision |
|----|----------|
| DD-1 | App 預設關閉，AI 自行判斷何時啟動（不靠關鍵字） |
| DD-2 | 安裝目錄：`/opt/opencode-apps/<id>/` |
| DD-3 | mcp-apps.json 兩層（/etc/opencode/ + ~/.config/opencode/），系統優先 |
| DD-4 | 建立 opencode 系統帳號做檔案歸屬隔離，gateway 保持 root 但檔案 chown opencode |
| DD-5 | Step 6 用 `bun build --compile` 產生零依賴 binary |
| DD-6 | 交付範圍 Step 0-6 全做 |

## Current State

- 設計完成，所有決策已確認（6 個 DD）
- 所有計劃檔已對齊最終需求
- IDEF0 + Grafcet companion artifacts 已建立
- 尚未開始實作

## Stop Gates In Force

- SG-1: Gmail/Calendar 功能不可中斷（每個 Step 都檢查）
- SG-2: 禁止靜默 fallback（AGENTS.md 第一條）
- SG-3: 路徑穿越必須被阻擋
- SG-4: bun test 必須通過

## Build Entry Recommendation

從 **Step 0**（Foundation: System User & Permissions）開始。

建議順序：
1. Step 0（前置基建，必須先完成）
2. Step 1 → Step 2 → Step 3（核心 pipeline，MVP 完成）
3. Step 4（UI，可與 Step 5 平行）
4. Step 5（對話驅動）
5. Step 6（內建 App 統一化，bun compile）

## IDEF0 Functional Decomposition

IDEF0 描述「解決問題需要哪些功能」，不直接對應程式結構或 Step 編號。

### Level 0 (Context)
| Activity | Title |
|----------|-------|
| A0 | Standardize MCP App Extensibility |

### Level 1 (5 functions)
| Activity | Title | 本質 |
|----------|-------|------|
| A1 | Prepare Runtime Environment | 基礎建設（帳號、目錄、權限） |
| A2 | Acquire App Package | 取得 App（clone、路徑、編譯） |
| A3 | Validate App Package | 驗證 App（manifest、schema、probe） |
| A4 | Register App Lifecycle | 管理 App 狀態（註冊、啟停、遷移） |
| A5 | Surface App Capabilities | 讓 App 能力可用（啟動、注入、UI、對話） |

### Level 2 (23 functions)
| Activity | Title | Parent |
|----------|-------|--------|
| A11 | Create System Service Account | A1 |
| A12 | Establish Directory Hierarchy | A1 |
| A13 | Configure Gateway Privileges | A1 |
| A14 | Migrate Temporary File Dependencies | A1 |
| A21 | Resolve Source Type | A2 |
| A22 | Clone Remote Repository | A2 |
| A23 | Verify Local Path Exists | A2 |
| A24 | Install Runtime Dependencies | A2 |
| A25 | Compile Builtin App Binary | A2 |
| A31 | Read Manifest File | A3 |
| A32 | Infer Manifest from Project Files | A3 |
| A33 | Validate Manifest Schema | A3 |
| A34 | Probe App via Stdio Handshake | A3 |
| A41 | Persist App Registration | A4 |
| A42 | Merge Two-Tier Configuration | A4 |
| A43 | Manage App State Transitions | A4 |
| A44 | Migrate Builtin App Registrations | A4 |
| A51 | Launch Stdio Transport | A5 |
| A52 | Inject Auth Credentials | A5 |
| A53 | Register Tools to Session Pool | A5 |
| A54 | Advertise Available Apps to AI | A5 |
| A55 | Render App Management Interface | A5 |
| A56 | Handle Conversational Provisioning | A5 |

### Level 3 (A55 decomposition: 4 functions)
| Activity | Title | Parent |
|----------|-------|--------|
| A551 | Serve App List API | A55 |
| A552 | Preview App Before Adding | A55 |
| A553 | Accept App Addition Request | A55 |
| A554 | Render App Card Components | A55 |

### IDEF0 → Tasks Cross-Reference

Tasks 的 Step 編號是「實作順序」，IDEF0 是「功能拆解」。一個 Step 可能用到多個 IDEF0 功能，一個 IDEF0 功能可能跨多個 Step。

| Step | 主要涉及的 IDEF0 功能 |
|------|---------------------|
| Step 0 | A11, A12, A13, A14 |
| Step 1 | A31, A32, A33 |
| Step 2 | A44 |
| Step 3 | A41, A42, A51, A52, A53, A54 |
| Step 4 | A551, A552, A553, A554 |
| Step 5 | A21, A22, A23, A24, A56 |
| Step 6 | A25, A44 (completion) |

## Grafcet Flow Summary

四條主要路徑，每步的 ModuleRef 指向 IDEF0 的 Level 2 功能：

1. **Provision Flow**（0→1→2→3→4→0）：A11→A12→A13→A14
2. **Install Flow**（0→20→21/22→23→24/25→26→27→28→29→0）：A21→A22/A23→A31→A33/A32→A24→A34→A41→A56
3. **Lifecycle Flow**（0→30→31/32/33→34→0）：A43→A51 (enable) / A43 (disable/remove)
4. **Startup Flow**（0→40→[41,42]→43→0）：A42→[A51, A54]→A53（並行分支）

Error steps（90-95）覆蓋 A11, A22, A23, A32, A33, A34 的失敗路徑。

## Diagram Files

```
plans/mcp-separation/
  idef0.json                                   ← A0 context (5 activities)
  grafcet.json                                 ← 4 flows, 30 steps
  diagrams/
    mcp-separation_a1_idef0.json               ← A1 decomposition (4 activities)
    mcp-separation_a2_idef0.json               ← A2 decomposition (5 activities)
    mcp-separation_a3_idef0.json               ← A3 decomposition (4 activities)
    mcp-separation_a4_idef0.json               ← A4 decomposition (4 activities)
    mcp-separation_a5_idef0.json               ← A5 decomposition (6 activities)
    mcp-separation_a55_idef0.json              ← A55 decomposition (4 activities)
```

## Execution-Ready Checklist

- [x] Proposal aligned to final requirement (including system account)
- [x] Spec covers all layers with scenarios
- [x] Design has decision table (DD-1 through DD-6)
- [x] Implementation spec has stop gates and critical files
- [x] Tasks organized by execution order (Step 0-6)
- [x] IDEF0 companion artifacts: 3 levels, 28 leaf functions, 7 diagram files
- [x] Grafcet companion artifact: 4 flows, 30 steps, 6 error paths
- [x] IDEF0 ↔ Tasks cross-reference established
- [x] All open questions resolved (6 decisions confirmed)
