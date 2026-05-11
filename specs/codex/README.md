# codex

> Wiki entry. Specs relating to upstream codex-cli (Rust) and how OpenCode's
> codex provider mirrors / diverges from it.

## Sub-packages

- [`cli-reversed-spec/`](./cli-reversed-spec/) — 12-chapter reverse-engineering reference of upstream codex-cli, anchored on commit `76845d716b720ca701b2c91fec75431532e66c74`. Each chapter carries IDEF0 + GRAFCET + path:line anchors. Read this **before** touching cache / wire-shape / transport in the OpenCode codex provider.

## How to use this scope

- Cache or protocol bug on the codex provider → start in `cli-reversed-spec/chapters/11-cache-prefix-model.md` (or the chapter matching the surface).
- Wire-shape divergence vs. upstream → diff against the pinned SHA referenced in the chapter, not against arbitrary upstream HEAD.
- Re-audit findings go into `cli-reversed-spec/events/` as events.
