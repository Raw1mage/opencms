# Observability

## Events

- `plugin.claude-cli.loaded` — Plugin 成功載入
  - **Payload**: `{ provider: "claude-cli" }`
  - **Emitter**: plugin/claude-cli/index.ts
  - **Consumers**: startup log

- `plugin.claude-cli.auth.loader` — auth.loader 被呼叫
  - **Payload**: `{ authType: "oauth"|"subscription", hasAccess: boolean, accountId: string }`
  - **Emitter**: plugin/claude-cli/index.ts
  - **Consumers**: debug log

- `plugin.claude-cli.getModel` — getModel 建立 LanguageModelV2
  - **Payload**: `{ modelId: string, viaProviderClaude: true }`
  - **Emitter**: plugin/claude-cli/index.ts
  - **Consumers**: debug log

- `plugin.claude-cli.auth.authorize` — OAuth authorize URL 產生
  - **Payload**: `{ method: "subscription"|"console" }`
  - **Emitter**: plugin/claude-cli/auth.ts
  - **Consumers**: info log

- `plugin.claude-cli.auth.exchange` — Token exchange 完成
  - **Payload**: `{ success: boolean, hasEmail: boolean }`
  - **Emitter**: plugin/claude-cli/auth.ts
  - **Consumers**: info log

## Metrics

- `claude_cli.auth.refresh_count` — Token refresh 次數
  - **Type**: counter
  - **Labels**: `result` (success|failure)
  - **Dashboard**: N/A（log-based tracking）

- `claude_cli.getModel.latency_ms` — getModel 呼叫延遲
  - **Type**: histogram
  - **Labels**: `modelId`
  - **Dashboard**: N/A（debug-only）

## Logs

所有 log 使用 `Log.create({ service: "plugin.claude-cli" })`，與現有 `plugin.claude-cli` service name 一致。

Log levels:
- `info`: auth lifecycle events（loaded, authorize, exchange, refresh）
- `debug`: getModel details, credential checks
- `warn`: dead code check（Phase 0 only, temporary）
- `error`: auth failures, import failures

## Alerts

此計畫無新 alert。Token refresh failure 由現有 provider-claude 的 error handling 覆蓋。
