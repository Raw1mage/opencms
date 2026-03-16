# Tasks for Kill-switch Implementation

1-spec: 完成 planner artifacts（implementation-spec.md, spec.md, design.md） — owner: planner — status: done

2-core-api: 實作 state store 與 API endpoints — status: done
- files: packages/opencode/src/server/killswitch/service.ts , packages/opencode/src/server/routes/killswitch.ts

3-rbac-mfa: 整合 RBAC 與 MFA 檢查到 API — status: done
- owner: backend/security

4-agent-check: 在 agent 啟動與 scheduler path 加入 check（短路新任務） — status: done
- owner: infra 

5-soft-kill: 實作 soft-pause signaling (Local transport) — status: done
- owner: infra

6-hard-kill: 實作 timeout 驅動的 force termination — status: done
- owner: infra

7-snapshot: snapshot generator 與稽核寫入 — status: done
- owner: infra/ops

8-cli: 實作 CLI 控制命令 — status: done
- file: packages/opencode/src/cli/cmd/killswitch.ts

9-web-ui: admin button 與 modal — status: pending
- owner: frontend

10-tui: TUI hotkey + confirmation flow — status: pending
- owner: tui

11-tests: 單元與集成測試 — status: done
- tests: packages/opencode/src/server/killswitch/service.test.ts, packages/opencode/src/server/routes/killswitch.test.ts

12-security-review: 安全團隊 review 並 sign-off — status: pending
- owner: security
