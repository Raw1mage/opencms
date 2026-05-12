---
name: wp-performance
description: "WordPress performance profiling and optimization (backend-only): WP-CLI profile/doctor, database/query optimization, autoloaded options, object caching, cron, HTTP API calls."
compatibility: "Targets WordPress 6.9+ (PHP 7.2.24+). Backend-only agent; prefers WP-CLI when available."
---

# WP Performance (backend-only)

## When to use

- A WordPress site/page/endpoint is slow (frontend TTFB, admin, REST, WP-Cron)
- You need a profiling plan and tooling recommendations
- You're optimizing DB queries, autoloaded options, object caching, cron tasks, or remote HTTP calls

This skill assumes the agent cannot use a browser UI. Prefer WP-CLI, logs, and HTTP requests.

## Inputs required

- Environment and safety: dev/staging/prod, any restrictions
- How to target the install: WP root `--path=<path>`, multisite `--url=<url>`
- Performance symptom and scope: which URL/route, when it happens

## Procedure

### 0) Guardrails: measure first
1. Confirm whether you may run write operations
2. Pick a reproducible target and capture a baseline (TTFB via curl, WP-CLI profiling)

### 1) Fast wins: diagnostics before deep profiling
- `wp doctor check` catches common production foot-guns
- Autoload bloat, SAVEQUERIES/WP_DEBUG left on, plugin counts

### 2) Deep profiling
1. `wp profile stage` - where time goes (bootstrap/main_query/template)
2. `wp profile hook` - find slow hooks/callbacks
3. `wp profile eval` - targeted code paths

### 3) Fix by category (pick dominant bottleneck)

**DB queries:**
- Reduce query count, fix N+1 patterns
- Improve indexes, avoid expensive meta queries

**Autoloaded options:**
- Identify biggest autoloaded options
- Stop autoloading large blobs

**Object cache misses:**
- Add persistent object cache
- Fix cache key/group usage

**Remote HTTP calls:**
- Add timeouts, caching, batching
- Avoid calling remote APIs on every request

**Cron:**
- Reduce due-now spikes, de-duplicate events
- Move heavy tasks out of request paths

### 4) Verify
- Re-run same measurement
- Confirm performance delta and unchanged behavior

## Failure modes
- "No change": measured different URL, caches masked results, opcode cache stale
- Noisy profiling: eliminate background tasks, warm caches, multiple samples
- SAVEQUERIES overhead: don't run in production unless approved

## Escalation
Do NOT in production without approval:
- Install plugins, enable SAVEQUERIES, run load tests, flush caches during traffic
