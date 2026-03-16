# Kill-Switch Runbook

## Overview

Kill-switch 提供全域暫停/恢復 agent 工作的能力。觸發後所有新 session 被阻擋，現有 session 進入 soft-pause → hard-kill 路徑。

---

## Trigger Paths

### Web Admin UI
1. Settings → Kill-Switch section
2. Click "Trigger Kill-Switch" → button 變為 "Confirm Trigger"
3. 輸入 reason → 再次點擊確認
4. 系統回傳 MFA challenge（202）
5. 輸入 MFA code → 確認
6. 成功：status badge 變紅，顯示 "active (soft_paused)"

### TUI
1. `/admin` → Kill-Switch → Trigger Kill-Switch
2. 輸入 reason → Confirm
3. 系統回傳 MFA challenge
4. 輸入 MFA code → 送出
5. Toast 顯示結果

### CLI
```bash
opencode killswitch trigger --reason "incident description"
# → MFA challenge returned
opencode killswitch trigger --reason "incident description" --request-id <id> --mfa-code <code>
# → triggered
```

### API
```bash
# Step 1: Initiate trigger (returns MFA challenge)
curl -X POST /api/killswitch/trigger \
  -H "Content-Type: application/json" \
  -d '{"reason": "incident description"}'
# → 202 { "mfa_required": true, "request_id": "ks_..." }

# Step 2: Complete with MFA
curl -X POST /api/killswitch/trigger \
  -H "Content-Type: application/json" \
  -d '{"reason": "incident description", "requestID": "ks_...", "mfaCode": "123456"}'
# → 200 { "ok": true, "request_id": "ks_...", "snapshot_url": "..." }
```

---

## Cancel Paths

### Web Admin UI
1. Click "Cancel Kill-Switch" → "Confirm Cancel" → 確認

### TUI
1. `/admin` → Kill-Switch → Cancel Kill-Switch → Confirm

### CLI
```bash
opencode killswitch cancel
```

### API
```bash
curl -X POST /api/killswitch/cancel \
  -H "Content-Type: application/json" \
  -d '{"requestID": "ks_..."}'
```

---

## Status Check

```bash
# API
curl /api/killswitch/status
# → { "ok": true, "active": true/false, "state": "soft_paused"/"inactive", ... }

# CLI
opencode killswitch status
```

---

## What Happens When Triggered

1. **State set**: `active=true, state=soft_paused`
2. **Snapshot created**: 系統快照寫入 local storage 或 MinIO/S3
3. **New sessions blocked**: `assertSchedulingAllowed()` 在 session route 中攔截，回傳 409 `KILL_SWITCH_ACTIVE`
4. **Busy sessions controlled**: 對每個 busy session 發送 `cancel` control message（seq/ack protocol）
5. **ACK timeout fallback**: 若 5s 內未收到 ACK，自動 force-kill
6. **Audit trail**: 所有 action 寫入 audit log
7. **SSE push**: `killswitch.status.changed` event 推送至 Web/TUI 即時更新

---

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `OPENCODE_KILLSWITCH_CONTROL_TRANSPORT` | Transport mode: `local` (default) or `redis` | No |
| `OPENCODE_REDIS_URL` | Redis URL for pub/sub transport | Only if transport=redis |
| `OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND` | Snapshot backend: `local` (default), `minio`, or `s3` | No |
| `OPENCODE_MINIO_ENDPOINT` | MinIO/S3 endpoint URL | Only if backend=minio/s3 |
| `OPENCODE_MINIO_ACCESS_KEY` | MinIO/S3 access key | Only if backend=minio/s3 |
| `OPENCODE_MINIO_SECRET_KEY` | MinIO/S3 secret key | Only if backend=minio/s3 |
| `OPENCODE_MINIO_BUCKET` | MinIO/S3 bucket name | Only if backend=minio/s3 |
| `OPENCODE_MINIO_REGION` | AWS region (default: us-east-1) | No |
| `OPENCODE_DEV_MFA` | Set to `true` to return MFA code in dev response | Dev only |

---

## Troubleshooting

### Kill-switch triggered but sessions still running
- Check audit log for force-kill entries
- Verify `OPENCODE_KILLSWITCH_CONTROL_TRANSPORT` matches deployment
- If using Redis: verify `OPENCODE_REDIS_URL` connectivity

### MFA code not received
- Dev/local: check `dev_code` in 202 response
- Production: MFA delivery channel not yet integrated (DD-2 pending)

### Snapshot URL is null
- Snapshot failure does not block kill path (by design)
- Check audit for `snapshot.failure` entry
- Verify MinIO/S3 credentials and bucket permissions

### 429 on trigger attempt
- Cooldown is 5s per initiator
- Wait and retry

### 409 on new session
- Kill-switch is active; cancel or wait for TTL expiry

---

## Escalation

1. **Ops**: If kill-switch cannot be canceled, restart the opencode server process
2. **Security**: If unauthorized trigger detected, check audit log for initiator + requestID
3. **Infra**: If Redis transport fails, fallback to `local` transport by unsetting `OPENCODE_KILLSWITCH_CONTROL_TRANSPORT`

---

# Postmortem Template

## Incident: [Title]

**Date**: YYYY-MM-DD
**Duration**: HH:MM → HH:MM (X minutes)
**Severity**: P1/P2/P3
**Kill-Switch Request ID**: ks_XXXXXXXXX

### Summary
[1-2 sentence description of what happened]

### Timeline
| Time | Event |
|------|-------|
| HH:MM | [trigger event] |
| HH:MM | [response action] |
| HH:MM | [resolution] |

### Kill-Switch Actions Taken
- [ ] Kill-switch triggered via [Web/TUI/CLI/API]
- [ ] Snapshot captured: [URL or "failed"]
- [ ] Sessions controlled: [N] busy sessions, [M] force-killed
- [ ] Kill-switch canceled at [time]

### Root Cause
[Description of root cause]

### Impact
- Users affected: [count/scope]
- Sessions interrupted: [count]
- Data loss: [none/description]

### Audit Evidence
```
[Paste relevant audit entries from Storage killswitch/audit/*]
```

### Action Items
| # | Action | Owner | Due | Status |
|---|--------|-------|-----|--------|
| 1 | | | | |

### Lessons Learned
- What went well:
- What went poorly:
- Where we got lucky:
