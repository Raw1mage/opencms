# Proposal: Claude Code CLI Reversed Spec (2.1.144)

## Why

OpenCMS 的 claude-cli provider 以 reproduction（重製複刻）方式複製 Claude Code CLI 的行為。需要完整的 wire protocol 逆向工程文件作為 single source of truth，確保 fingerprint 對齊。

上一版對齊到 2.1.126。2.1.144 有重大變更：16 個新 beta flags、新 `anthropic-client-platform` header、billing header 格式變更、OAuth scope 擴充。此外，rate limit 碰軟釘子的問題需要完整理解 CLI 的兩層 retry 架構。

## Original Requirement Wording (Baseline)

- "先pull claude最新cli source並經過miatdiagram, plan-builder, specbase的方法論逆向後解析出完整datasheet/whitepaper, 在/specs/中建立文件系統"

## Requirement Revision History

- 2026-05-19: initial draft — from 2.1.144 binary extraction + reverse engineering

## Effective Requirement Description

1. **R1**: 從 `@anthropic-ai/claude-code@2.1.144` 提取並逆向 wire protocol
2. **R2**: 建立完整 protocol datasheet 覆蓋 auth、headers、beta flags、retry/backoff、SSE、request body
3. **R3**: 記錄 2.1.126 → 2.1.144 delta
4. **R4**: 建立 IDEF0/GRAFCET diagrams 覆蓋 retry pipeline

## Scope

### IN
- Wire protocol: headers, auth, beta flags, request/response body
- Retry/backoff: 兩層架構（SDK + app）、constants、decision flow
- SSE transport: event types, parser, error handling
- Rate limit: unified rate limit headers、status machine
- Model routing: provider routes, model families
- Tool system: mcp__ prefix, built-in tools
- Cache control: breakpoints, TTL, scope
- Context management: auto-compact, boundary markers

### OUT
- Tool implementation details (bash, web_fetch 內部邏輯)
- Agent orchestration / subagent spawning
- UI/TUI rendering logic
- Session persistence / snapshot
- MCP server discovery
- Skills / triggers / environments API

## Non-Goals

- 逆向 CLI 的全部功能（僅 wire protocol）
- 測試 CLI binary 本身

## Constraints

- Source: minified bundle（19641 行，~14MB），variable names 被 mangle
- 無法執行 CLI（只做靜態分析）

## What Changes

- `specs/claude-cli/cli-reversed-spec/` — NEW: 完整逆向工程 spec package
- `refs/claude-code-npm/cli.js` — UPDATED: 2.1.112 → 2.1.144

## Capabilities

### New Capabilities
- **Protocol datasheet**: 完整的 wire protocol 文件，可作為 provider-claude 對齊參考
- **Retry architecture**: 兩層 retry 的完整理解，解釋 rate limit 行為差異
- **Delta tracking**: 2.1.126 → 2.1.144 變更清單

### Modified Capabilities
- **refs/claude-code-npm/cli.js**: 更新到 2.1.144

## Impact

- `specs/claude-cli/cli-reversed-spec/` — 新建 spec package
- `packages/provider-claude/src/protocol.ts` — 需要對齊更新（不在此 spec 範圍，另開 task）
