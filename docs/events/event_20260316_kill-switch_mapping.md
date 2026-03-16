Event: mapping and A-phase kick-off

Actions taken:

- Created specs/20260316_kill-switch/mapping.md
- Added Redis client wrapper, audit_service backed by Redis list
- Implemented control_channel publishControl using Redis pending keys + ack polling
- Implemented worker_control_handler that subscribes and enforces seq > last_seq
- Added snapshot_service with MinIO adapter fallback to local files
- Added admin route sketch at src/server/routes/admin/kill_switch.ts

Env variables required for local testing:

- OPENCODE_REDIS_URL (e.g., redis://127.0.0.1:6379)
- OPENCODE_MINIO_ENDPOINT (optional, to enable MinIO upload)
- OPENCODE_MINIO_ACCESS_KEY, OPENCODE_MINIO_SECRET_KEY, OPENCODE_MINIO_BUCKET

Next steps: implement Redis-backed pendingAcks improvements, create feature branch, wire into runner start-up, and replace stubs with durable implementations.

Audit log (sample):

- t1: branch creation and initial wiring -> completed
- t2: MFA integrated into /admin/kill-switch/trigger -> in_progress

Recent actions performed:

- Generated MFA challenge and recorded audit entry (mfa_challenge_generated)
- Verified MFA code and recorded audit entry (mfa_verified)
- Created snapshot via snapshot_service and recorded (kill_switch.trigger)
- Published control message; on timeout recorded control.timeout and kill_switch.trigger_failed when applicable
