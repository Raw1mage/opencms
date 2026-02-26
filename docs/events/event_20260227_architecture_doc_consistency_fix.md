# Event: ARCHITECTURE.md consistency corrections

Date: 2026-02-27
Status: Done

## Scope

- Correct documentation-level inconsistencies in `docs/ARCHITECTURE.md`.

## Changes

1. Fixed markdown code-fence structure around the dependency graph section:
   - Added missing closing fence after the Mermaid graph.
   - Removed stray trailing fence later in the file.
2. Updated events naming convention text:
   - `event_log_YYYYMMDD_topic.md` -> `event_YYYYMMDD_topic.md`.
3. Resolved provider toggle rule conflict:
   - Unified wording to canonical root action: `Space` toggle; root `Delete` disabled/hidden.
4. Fixed duplicate heading number:
   - `## 18. Web Auth Credential Management Baseline` -> `## 19. ...`.

## Rationale

- Keep architecture doc aligned with current repo conventions and current `/admin` interaction contract.
- Remove contradictory guidance that could mislead contributors and agents.
