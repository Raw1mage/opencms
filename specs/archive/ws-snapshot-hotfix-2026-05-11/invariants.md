# Invariants

- INV-HF-01: Every empty-turn classifier snapshot must carry numeric `wsFrameCount`.
- INV-HF-02: `terminalEventReceived=false` plus numeric `wsFrameCount` must not classify as `unclassified` unless a future explicit cause-family rule says so.
- INV-HF-03: Existing JSONL rows are append-only evidence and must not be edited in place.
- INV-HF-04: The provider package remains independent from opencode runtime globals.
