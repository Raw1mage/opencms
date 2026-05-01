# Invariants: compaction-improvements

- **INV-1** The message stream remains the authoritative compaction history.
- **INV-2** Compaction must not recursively trigger inside its own child runloop.
- **INV-3** Provider-specific codex economics do not leak into generic prompt contracts.
- **INV-4** Context budget surfacing is informational only and carries no action instruction.
- **INV-5** Oversized raw boundary content never enters the parent model context after routing.
- **INV-6** Storage or worker failures fail explicitly; no silent first-N fallback is introduced without approval.
- **INV-7** Telemetry carries decision metadata, not raw secret-bearing content.
