# Repo Reverse Engineering Pipeline (for miatdiagram)

## Goal

Convert an existing repository into evidence-backed MIAT artifacts:

- IDEF0 for functional/module structure
- GRAFCET for behavioral/runtime control flow

## Source priority

1. Framework / architecture docs
2. Event / decision history
3. Entrypoints and runtime wiring
4. Module boundaries and adapters
5. State/lifecycle/control-flow logic
6. Supporting implementation detail

## Reverse-engineering workflow

1. **Scope lock**
   - Determine whole-repo vs subsystem analysis.
   - Confirm desired depth (`A0` only, `A0+A1`, deeper decomposition).
2. **Source inventory**
   - List relevant docs, packages, apps, services, entrypoints, and runtime surfaces.
3. **Boundary map**
   - Identify external actors, user interfaces, APIs, persistence, providers, background workers, and cross-process boundaries.
4. **Responsibility slicing**
   - Group files/components by runtime responsibility rather than folder naming alone.
5. **ICOM extraction**
   - Input: transformed data/material
   - Control: config, policies, env, feature gates, permissions
   - Output: emitted state, response, event, artifact
   - Mechanism: DB, SDK, worker, tool, service, operator
6. **Behavior extraction**
   - Identify steps, triggers, guards, forks, joins, retries, and terminal states.
   - Prefer observable runtime transitions over speculative state diagrams.
7. **Traceability matrix**
   - Link each IDEF0 module to source files and each GRAFCET scope to lifecycle/control evidence.
8. **Normalization**
   - Compress low-value implementation noise.
   - Preserve causal structure and parent-child ancestry.
9. **Validation**
   - Ensure no orphan GRAFCET scope, no invented boundary, and no unexplained top-level module.

## Reverse-engineering heuristics

- Start from entrypoints, coordinators, and long-lived state owners.
- Treat routers/dispatchers/orchestrators as control-plane evidence.
- Treat event buses, queues, SSE, websocket channels, and cron/worker loops as strong GRAFCET candidates.
- Treat policies/config/env/feature flags as Controls in IDEF0.
- Prefer 3-7 L1 modules for readability; only expand deeper where evidence supports it.

## Required reverse-engineering outputs

- `source_inventory`
- `boundary_map`
- `evidence_trace`
- `traceability_matrix`
- `confidence_notes`

## Anti-patterns

- Deriving modules from directory names alone
- Equating every class/file to a first-class IDEF0 activity
- Inventing runtime transitions not observable in code or docs
- Mixing infrastructure mechanism with transformed business input
- Using fallback assumptions without marking uncertainty
