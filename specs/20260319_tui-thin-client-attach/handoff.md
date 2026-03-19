# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding
- Materialize tasks.md into runtime todos before coding

## Required Reads

- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md
- 現有 architecture: specs/architecture.md
- Phase 1 event log: docs/events/event_20260319_account_manager_unified_refactor.md
- 現行 sudo-n 機制: packages/opencode/src/system/linux-user-exec.ts
- 現行 TUI Worker: packages/opencode/src/cli/cmd/tui/thread.ts, worker.ts
- 現行 attach: packages/opencode/src/cli/cmd/tui/attach.ts
- 現行 Bus: packages/opencode/src/bus/index.ts
- 現行 SSE: packages/opencode/src/server/routes/global.ts

## Current State

- Phase 1 完成：AccountManager service layer + terminology migration
- Phase 2 hardening plan 已建立但延後（specs/20260319_account-manager-phase2-hardening/）
- Daemon refactor plan 完成，尚未開始實作
- Branch: 建議從 cms 分出 `daemon-refactor`

## Architecture Summary

```
                    ┌── Browser (:1080) ──┐
                    │                     │
              ┌─────▼─────────────────────▼──────┐
              │     C Root Daemon (:1080)         │
              │  • login.html serve               │
              │  • PAM auth → JWT cookie          │
              │  • fork+setuid → per-user daemon  │
              │  • splice() kernel-level proxy     │
              └──────────┬───────────────┬────────┘
                         │               │
              ┌──────────▼──┐   ┌────────▼────────┐
              │ Per-user A  │   │ Per-user B       │
              │ uid=alice   │   │ uid=bob          │
              │ Unix socket │   │ Unix socket      │
              │ 完整 opencode│   │ 完整 opencode    │
              └──────▲──────┘   └─────────────────┘
                     │
              ┌──────┴──────┐
              │ TUI (alice) │ ← Unix socket 直連（不經 root daemon）
              └─────────────┘
```

### 連線協定

| Client | 路徑 | 協定 |
|--------|------|------|
| Webapp (browser) | → root daemon :1080 → splice → per-user Unix socket | TCP → splice → Unix socket |
| TUI (同 UID) | → per-user Unix socket 直連 | Unix socket |

### 與現行架構的差異

| 面向 | 現行 | 新架構 |
|------|------|--------|
| 身份切換 | per-command sudo -n | per-user daemon setuid（一次性）|
| TUI backend | Worker thread embedded server | Unix socket client attach |
| 特權範圍 | daemon 持有全域 sudo | root daemon 只做 auth+spawn，per-user 無特權 |
| State 共享 | TUI 和 webapp 完全隔離 | 共享同一個 per-user daemon |
| Bus events | 只在 process 內 | 透過 SSE 跨 client |

## Stop Gates In Force

- **SG-1**: Phase α 開始前，確認 PAM C API 可用且可編譯
- **SG-2**: Phase α 完成後，確認 splice() 對 HTTP/SSE/WebSocket 正確轉發
- **SG-3**: Phase γ 開始前，確認 Bun Unix socket HTTP client 可正常運作
- **SG-4**: Phase δ 開始前，確認所有 LinuxUserExec 使用點已列出
- **SG-5**: Phase θ 開始前，確認 SDK cache memory baseline

## Build Entry Recommendation

**建議起點：Phase α + β 平行開發**

Phase α（C daemon）和 Phase β（Unix socket mode）可以平行進行，兩者完成後才能做 Phase γ（TUI attach）和 Phase δ（security migration）。

```
建議執行順序：

Phase α（C daemon）──────┐
                         ├──→ Phase γ（TUI）──→ Phase δ（Security）
Phase β（Unix socket）───┘
        ↕ 可平行
Phase ε（Account events）──→ Phase ζ（SSE catch-up）──→ Phase η（Payload）
        ↕ 可平行
Phase θ（Performance）

最後：Phase ω（webctl.sh + cross-cutting）
```

Phase ε/ζ/η（Bus 強化）可與 α/β 平行進行。
Phase θ（效能）可在任何時間進行。

## Key Technical Notes

1. **C daemon 編譯**：`gcc -o opencode-gateway daemon/opencode-gateway.c -lpam -lpam_misc`（需 libpam-dev）
2. **splice() 需要 pipe pair**：`pipe2(pipefd, O_NONBLOCK)` → `splice(src, pipe_wr)` + `splice(pipe_rd, dst)`
3. **Bun.serve({ unix })** 原生支援 Unix domain socket
4. **Bun fetch over Unix socket**：`fetch("http://localhost/api/v2/...", { unix: "/path/to/sock" })`
5. **Discovery file 位置**：`$XDG_RUNTIME_DIR/opencode/daemon.json`（通常 `/run/user/$UID/opencode/daemon.json`）
6. **PID 存活檢查**：`kill(pid, 0)` — 不發送信號
7. **JWT signing**：C daemon 用 HMAC-SHA256，secret 從 `/etc/opencode/gateway.secret` 讀取
8. **TUI 雙模式**：`opencode`（獨立模式，保留 Worker thread）vs `opencode --attach`（連到 per-user daemon）。Attach 模式找不到 daemon → fail fast。兩者不互相 fallback
9. **Per-user daemon port 是 webctl.sh 定義的 WEB_PORT (1080)**：但在新架構下 per-user daemon 用 Unix socket，不 listen TCP port
10. **Event payload sanitization**：Account.Info 中的 apiKey, refreshToken 必須在 SSE 傳送前移除
11. **splice() 未來可替換**：若 Bun 支援 `handleConnection(fd)`，切換為 fd passing 只需改 C daemon 和 opencode 各一個函式

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
- [x] Stop gates identified and documented
- [x] Branch strategy confirmed（新 branch from cms）
- [ ] SG-1: PAM C API 可用性確認
- [ ] SG-2: splice() 三協定轉發確認
- [ ] SG-3: Bun Unix socket client 確認
- [ ] SG-4: LinuxUserExec 使用點全列
- [ ] SG-5: SDK cache memory baseline
