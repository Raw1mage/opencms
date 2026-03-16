# Mapping: spec → code locations

This file maps kill-switch spec items to concrete code locations and owners in the opencode repo.

## High-level mappings

- Control protocol (seq/ACK): specs/20260316_kill-switch/control-protocol.md
  - Implementation: server/control/control_channel.ts (orchestrator side) and server/worker/worker_control_handler.ts (worker side)
  - Transport: Redis pub/sub (recommended prototype)

- RBAC hooks: specs/20260316_kill-switch/rbac-hooks.md
  - Implementation: server/middleware/rbac_middleware.ts and API routers under src/server/routes/admin/kill_switch.ts and src/server/routes/tasks.ts

- Persistent state (kill_switch:state, last_seq, pendingAcks, audit):
  - Implementation: Redis (keys: kill_switch:state, control:last_seq:{request_id}, control:pending:{request_id}:{seq}, audit:ledger list)

- Snapshot orchestration: specs/20260316_kill-switch/snapshot-orchestration.md
  - Implementation hooks: src/server/services/snapshot_service.ts (MinIO / S3 adapter), callsites in routes/admin/kill_switch.ts

## Files to modify / create (owner suggestions)

- src/server/control/control_channel.ts — replace EventEmitter-based channel with Redis-backed pub/sub + pending ack keys. (Owner: backend)
- src/server/services/redis_client.ts — new Redis client wrapper and util functions. (Owner: infra/backend)
- src/server/services/audit_service.ts — replace in-memory audit with Redis list append and optional durable export. (Owner: backend)
- src/server/services/snapshot*service.ts — add MinIO upload adapter, configurable via env OPENCODE_SNAPSHOT*\* vars. (Owner: backend)
- src/server/worker/worker_control_handler.ts — worker-side ack handler, last_seq enforcement, persist last_seq to Redis. (Owner: workers)
- src/server/worker/worker_manager.ts — implement forceKill that can call container/PID kill via orchestrator or system API. (Owner: infra)
- src/server/routes/admin/kill_switch.ts — ensure RBAC + request_id + snapshot_url writeback to audit. (Owner: api)

## Config / Environment

- OPENCODE_REDIS_URL — Redis connection string
- OPENCODE_MINIO_ENDPOINT, OPENCODE_MINIO_ACCESS_KEY, OPENCODE_MINIO_SECRET_KEY, OPENCODE_MINIO_BUCKET — MinIO config

## Notes and next steps

- This mapping assumes Redis is available in target environment. If not, fallback to in-memory prototype must remain behind feature flag.
- MFA integration is deferred; add MFA hooks in rbac_middleware but keep stubs for now.
