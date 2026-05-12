---
name: wp-wpcli-and-ops
description: "WordPress operational tasks using WP-CLI: search-replace, database ops, plugin/theme management, cron, cache, multisite, automation scripting. Targets WordPress 6.9+ with PHP 7.2.24+."
---

# WP-CLI and Ops Skill

This skill enables WordPress operational tasks using WP-CLI, targeting WordPress 6.9+ with PHP 7.2.24+ and requiring WP-CLI in the execution environment.

## Primary Use Cases

- `wp search-replace` (URL changes, domain migrations, protocol switch)
- Database operations
- Plugin/theme management
- Cron event handling
- Cache flushing
- Multisite operations
- Automation scripting

## Key Workflow Steps

### Safety First
Before executing write operations:
1. Confirm the environment (dev/staging/production)
2. Validate site targeting via `--path` and `--url` parameters
3. Create backups for risky tasks

### Inspection
Verify WP-CLI availability and proper site targeting before proceeding.

### Operation Selection

**URL Migration:**
1. Always run `wp search-replace --dry-run` first
2. Check serialized data handling
3. Validate with `--precise` for complex replacements
4. Run actual replacement
5. Flush caches after

**Plugin/Theme Management:**
- `wp plugin list --status=active` to audit
- `wp plugin activate/deactivate <plugin>`
- `wp theme list` / `wp theme activate <theme>`

**Database Operations:**
- `wp db export <file>` before destructive ops
- `wp db query` for raw SQL
- `wp db optimize` / `wp db repair`

**Cron/Queue:**
- `wp cron event list` to inspect
- `wp cron event run <hook>` to trigger manually
- `wp cron event delete <hook>` to clean up

**Cache:**
- `wp cache flush`
- `wp transient delete --all`
- `wp rewrite flush`

### Automation
- Use `wp-cli.yml` for configuration defaults
- Shell scripts with error handling for repeatable operations

## Critical Safeguards

WP-CLI commands can be destructive. Before running anything that writes:
1. Confirm environment (dev/staging/prod)
2. Confirm targeting (path/url) so you don't hit the wrong site
3. Make a backup when performing risky operations

### Common Failure Modes
- Incorrect `--path` values
- Missing `--url` flags in multisite environments
- Serialization issues during search-replace operations
- Running write operations on production without backup
