# Invariants

- INV-1: A toast older than its `ttlMs` must not call `showToast`.
- INV-2: A toast without valid freshness metadata must not call `showToast`.
- INV-3: User/workspace/session-scoped toast intent must not be silently treated as a system/global broadcast.
- INV-4: State recovery remains reducer/resync-owned; toast TTL must not drop state events.
