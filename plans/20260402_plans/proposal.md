# Proposal

## Why

- Account switching now preserves session continuity well enough that stale provider-issued remote references can survive into the next turn.
- For Codex/OpenAI-style Responses, those remote refs are account-scoped; reusing them across account boundaries causes hard failures such as `text part msg_* not found`.
- The product needs a general lifecycle for identity change that keeps local semantic context while flushing invalid remote continuity.

## Original Requirement Wording (Baseline)

- "開一個plan，對於dialog continuation所需的checkpoint reuse and ref flush做一個，體規劃"
- "換了account，應該要重新給server新的前後文，並清除這些無效ref"
- "我們不是有實作checkpoint機制嗎？可以在這種時候派上用場嗎？節省新account pickup context的成本"
- "那account switching的時候要做的事可以通用化嗎，就是清理remote ref並引用checkpoint來代替大量的session history replay"

## Requirement Revision History

- 2026-04-02: Initial planning request focused on checkpoint reuse + ref flush for dialog continuation.
- 2026-04-02: Investigation narrowed the active bug to same-provider/same-model account switching on Codex/OpenAI-style Responses.
- 2026-04-02: Requirement expanded from bug fix to reusable lifecycle design: identity change should flush provider-specific remote refs and warm-start via checkpoint instead of replaying large stale history.

## Effective Requirement Description

1. Define a formal dialog-continuation contract for execution-identity change (provider/account/model) that distinguishes local semantic context from provider-issued remote continuity.
2. Require stale remote refs to be flushed when identity boundaries are crossed, especially for same-provider/same-model account switching.
3. Reuse checkpoint/synthetic summary to reduce pickup cost for the new identity instead of replaying a large session history.
4. Generalize the lifecycle so the orchestration flow is shared, while provider-specific ref flushing remains adapter-owned.
5. Treat Codex/OpenAI-style Responses as the first concrete implementation slice without pretending `msg_*` is a universal provider protocol.

## Scope

### IN

- Execution-identity change lifecycle for dialog continuation.
- Checkpoint-assisted warm start after account/provider switch.
- Provider-specific remote-ref flush hooks.
- Codex/OpenAI-style Responses as the first target surface.
- Session/runtime/provider boundary documentation for this lifecycle.

### OUT

- Full rollout to every provider in one implementation step.
- UI redesign unrelated to identity-change lifecycle.
- Silent fallback to old remote refs when provider evidence is incomplete.
- New remote ref standardization across providers.

## Non-Goals

- Making every provider expose the same remote-ref protocol.
- Preserving remote continuity across accounts/providers at all costs.
- Replacing checkpoint compaction with a brand-new memory system.

## Constraints

- Must preserve local semantic context while dropping only invalid remote continuity.
- Must remain fail-fast when provider-specific flush scope is ambiguous.
- Must not treat `msg_*` / `item_reference` as a cross-provider universal protocol.
- Must align replay identity boundaries with existing session execution identity semantics.

## What Changes

- Introduce a formal identity-change continuation contract.
- Define provider hook points for remote continuity flush.
- Reframe checkpoint reuse as the preferred warm-start mechanism after account/provider switch.
- Add validation criteria for no stale remote refs after identity change while preserving same-identity continuation.

## Capabilities

### New Capabilities

- Identity-change continuation lifecycle: explicit flush + warm-start sequence.
- Provider-aware remote continuity reset hooks.
- Checkpoint-assisted context pickup for new accounts without replaying full stale history.

### Modified Capabilities

- Dialog continuation: no longer assumes same provider/model is sufficient to preserve remote refs; accountId becomes a hard continuity boundary.
- Account switching: transitions from accidental continuity leakage to explicit reset + semantic carry-forward.

## Impact

- Affected code spans session replay, provider serializers, sticky turn state, websocket continuation, and account-switch UX/runtime coupling.
- Codex/OpenAI Responses should become safer under account switching without reverting to full-history replay as the default fallback.
- The plan will create a reusable framework for future provider adapters to participate in identity-change cleanup.
