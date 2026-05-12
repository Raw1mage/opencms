# Errors

## Error Catalogue

Every error code used at runtime must appear here with its canonical message, HTTP/exit status (if applicable), triggering condition, and recovery strategy.

- **AUTH_EXAMPLE** — placeholder error
  - **Message**: "Example error message shown to users"
  - **Status**: 401
  - **Trigger**: when example condition fails
  - **Recovery**: suggest the user retry / re-authenticate / contact support
  - **Layer**: example-layer

## Error Code Format

- UPPER_SNAKE_CASE, domain-prefixed (AUTH_*, DB_*, RATE_*, etc.)
- Codes are stable; messages may be revised (with supersede marker in history)

## Recovery Strategies

Summarize the recovery tree: transient retry, user-facing re-auth, fallback path, circuit break, etc. Each error above should point to one of the strategies declared here.
