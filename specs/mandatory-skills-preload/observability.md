# Observability: mandatory-skills-preload

Events / metrics / logs / alerts introduced by this spec. Dashboard ("已載技能") integration points.

## Log Lines

All logs use the `mandatory-skills` service prefix via `Log.create({ service: "mandatory-skills" })` in `mandatory-skills.ts`.

| Level | Message | Payload | Source Call Site |
|---|---|---|---|
| `info` | `[mandatory-skills] resolved list` | `{ sessionID, agent, isSubagent, list, bySkill }` | `resolveMandatoryList` end |
| `info` | `[mandatory-skills] preloaded skill` | `{ sessionID, skill, source, skillMdPath, bytes }` | `preloadMandatorySkills` per-skill success |
| `info` | `[mandatory-skills] reused cached entry` | `{ sessionID, skill }` | `preloadMandatorySkills` when entry already pinned + content unchanged |
| `info` | `[mandatory-skills] unpinned on removal` | `{ sessionID, skill, reason }` | `reconcileMandatoryList` per-skill unpin |
| `warn` | `[mandatory-skills] skill file missing` | `{ sessionID, skill, source, searchedPaths }` | preload miss |
| `warn` | `[mandatory-skills] malformed sentinel block` | `{ path, openerLine, closerLine, reason }` | `parseMandatorySkills` on bad block |
| `warn` | `[mandatory-skills] cache mtime probe failed` | `{ path, error }` | instruction-cache mtime read failure |
| `error` | `[mandatory-skills] failed to read SKILL.md` | `{ sessionID, skill, skillMdPath, error }` | preload read error |

## Events

Appended via `RuntimeEventService.append`. Consumed by dashboard + session detail drawer.

### skill.mandatory_preloaded

- **Level**: `info`
- **Domain**: `workflow`
- **Anomaly flags**: `[]`
- **Trigger**: `preloadMandatorySkills` successfully loads + pins a skill for the first time in this session.
- **Payload**: `{ skill: string, source: MandatorySource, skillMdPath: string }`
- **Dashboard use**: Timeline "mandatory skill preloaded" entry; can aggregate per-session.

### skill.mandatory_missing

- **Level**: `warn`
- **Domain**: `anomaly`
- **Anomaly flags**: `["mandatory_skill_missing"]`
- **Trigger**: Preload path resolution fails or read ENOENT.
- **Payload**: `{ skill: string, source: MandatorySource, searchedPaths: string[] }`
- **Dashboard use**: Anomaly counter increments; red-dot indicator in "已載技能" panel showing N mandatory skills missing on this session.

### skill.mandatory_read_error

- **Level**: `warn`
- **Domain**: `anomaly`
- **Anomaly flags**: `["mandatory_skill_read_error"]`
- **Trigger**: SKILL.md exists but read I/O fails.
- **Payload**: `{ skill: string, source: MandatorySource, skillMdPath: string, error: string }`
- **Dashboard use**: Same as `mandatory_missing` but signals transient infra issue (permissions, disk).

### skill.mandatory_unpinned

- **Level**: `info`
- **Domain**: `workflow`
- **Anomaly flags**: `[]`
- **Trigger**: `reconcileMandatoryList` unpins a skill that the user removed from AGENTS.md / coding.txt.
- **Payload**: `{ skill: string, reason: "removed_from_list" | "source_file_deleted" }`
- **Dashboard use**: Audit trail for mandatory list churn.

### skill.mandatory_parse_warn

- **Level**: `warn`
- **Domain**: `anomaly`
- **Anomaly flags**: `["mandatory_sentinel_malformed"]`
- **Trigger**: `parseMandatorySkills` encounters a malformed block.
- **Payload**: `{ sourceFile: string, openerLine: number, closerLine: number | null, reason: string }`
- **Dashboard use**: Surface broken AGENTS.md so user can fix.

## Metrics

If metrics infrastructure is added later:

- `mandatory_skills_pinned_total{sessionID, source}` (gauge) — how many mandatory skills currently pinned
- `mandatory_skills_preload_duration_ms{source}` (histogram) — first-time preload latency per skill
- `mandatory_skills_missing_total{skill}` (counter) — cumulative missing count across all sessions
- `mandatory_skills_cache_hit_ratio` (ratio) — parseMandatorySkills cache hits / total resolutions

## Dashboard Integration

### "已載技能" panel expected behavior after this spec lands

| State | What user sees |
|---|---|
| New Main Agent session, `plan-builder` in list, skill file present | `plan-builder` card with 📌 pinned badge + source label "mandatory: AGENTS.md" |
| Same session, 35 min idle | `plan-builder` card still pinned, NO decay indicator |
| `plan-builder` SKILL.md missing | No card rendered; red-dot anomaly indicator at top of panel with "1 mandatory skill missing" |
| User edits AGENTS.md to drop `plan-builder` from sentinel | Next round: card's 📌 badge disappears; normal idle-decay rules now apply; audit event visible in drawer |

### Session detail drawer (future)

- Section "Mandatory Skills" lists current pinned entries with source + preload timestamp.
- Section "Anomalies" aggregates `skill.mandatory_missing` / `*_read_error` / `*_parse_warn` events for this session.

## Alerts (operator-facing, future)

Phase 1 does not define paging alerts. Candidate alerts when metrics pipeline matures:

- `mandatory_skills_missing_total` increasing in a 5-min window across multiple sessions — suggests infra drift (skill library disappearing).
- `mandatory_skills_preload_duration_ms` p95 > 100 ms for > 10 min — suggests disk I/O issue.

## Log Correlation

All mandatory-skills logs carry `sessionID`. Cross-reference with:

- `runtime-event-service` domain `workflow` / `anomaly` events
- `session-status` busy/retry transitions
- `skill-layer-registry` entry state changes (existing log lines)

## Sampling / Retention

- Logs: standard opencode daemon logging; no special sampling.
- Events: `RuntimeEventService` existing retention (per-session event log, rotating).

## Debug Toggle

- `log.create({ service: "mandatory-skills" })` level inherits from global. No custom env flag needed; `DEBUG=*` already enables info-level tracing.
