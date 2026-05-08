# gpt-5.5 itemCount-sensitivity RCA — 2026-05-09

## TL;DR

The post-2026-05-02 wave of `ws_truncation` and `server_failed`
empty-turn classifications on codex sessions (avg inputItemCount
~320 / 397 respectively, observed @ items=230 in extreme cases)
correlates with the gpt-5.5 release window. Comparing model configs
in [refs/codex/codex-rs/models-manager/models.json](../../refs/codex/codex-rs/models-manager/models.json):

| Field | **gpt-5.5** | gpt-5.4 |
|---|---|---|
| `context_window` | 272000 | 272000 |
| **`max_context_window`** | **272000** (hard cap) | **1000000** (4× headroom) |
| `auto_compact_token_limit` | null | null |
| `default_reasoning_level` | medium | xhigh |
| `truncation_policy` | tokens/10000 | tokens/10000 |
| `prefer_websockets` | true | true |

The 4× difference in `max_context_window` is the load-bearing change.
gpt-5.4 sessions could carry 800+ input items because the codex
backend had a 1 M ceiling to absorb structural overhead; gpt-5.5
sessions hit a hard ceiling at 272 K and the backend's input-array
processing tightens accordingly.

User-observable consequence: starting late April / early May 2026
opencode sessions on gpt-5.5 began showing `ws_truncation` @
frames=3 (early stream cut) and `server_failed` @ frames=1
(pre-execution rejection) at item counts that were routine on
prior models. Combined with our (now-disabled) compaction-fix
Phase 1 v1–v6 misadventure, this produced the perceptible
"sudden onset" of paralysis loops on 2026-05-08.

## Why nobody noticed for 4 months

Every prior month's runtime was on gpt-5.4 / 5.3-codex / 5.2-codex
where `max_context_window=1000000`. Sessions could grow item count
to high numbers without backend rejection. The "300-400 items
failure zone" we documented in [specs/fix-empty-response-rca/](../../specs/fix-empty-response-rca/)
RCA on 2026-05-07 was already gpt-5.5-flavored data — we just
hadn't realized it was model-specific.

## Mitigation in place

[packages/opencode/src/session/prompt.ts](../../packages/opencode/src/session/prompt.ts)
paralysis × bloated-input compaction trigger (commit `077214fe7`):
when the 3-turn paralysis detector fires AND estimated codex input
item count exceeds 250, run `SessionCompaction.run({observed:
"overflow"})` instead of the recovery nudge. Compaction produces a
fresh anchor; next iteration's `applyStreamAnchorRebind` slices
from there with a sane prompt size.

Threshold rationale: 250 leaves a 50–100 buffer below the
empirical 300+ failure region. Considered lowering to 200 after a
single 230-item ws_truncation observation; reverted because if
200 were a hard ceiling we would have seen continuous loops for
the past 4 months.

## Forward outlook

If OpenAI raises gpt-5.5's `max_context_window` to match the 5.4-era
1 M ceiling (likely once the rollout matures), this paralysis ×
itemCount mitigation becomes dormant code that almost never fires.
That's fine — the trigger is gated by paralysis detection too, so
non-paralyzed sessions never pay the compaction cost.

## Cross-reference

- [specs/fix-empty-response-rca/](../../specs/fix-empty-response-rca/)
  — original empty-turn classification + DD-9 ladder. The 51 events
  recorded in `~/.local/state/opencode/codex/empty-turns.jsonl`
  underlying that RCA were all on gpt-5.5; the inputItemCount
  distribution we documented (server_failed avg=397, ws_truncation
  avg=320) is gpt-5.5-specific behavior, not a universal codex
  backend property.
- [specs/compaction-fix/](../../specs/compaction-fix/) — 2026-05-08
  Phase 1 misadventure post-mortem. Disabled per-turn transformer
  in commit `c1feb48a1`.
- Compaction priority commit `39bc97786` (2026-05-08): codex
  always tries server-side `/responses/compact` first regardless
  of context ratio, since codex subscription doesn't bill the
  call.
