# Spec: prompt-cache-and-compaction-hardening

## Purpose

把 system role 收斂為純 static prelude、把 dynamic 內容下放至 user-role context message，使 cache prefix 命中率穩定且最大化；同時修補 4 個會破壞 conversation 中固定資訊的 compaction bug。架構修正 + 機制硬化雙線並行，但兩線可獨立交付。

## Glossary

| 詞 | 意義 |
|---|---|
| **Static system block** | 一次 session 內幾乎不變的 7 個層（L1/L2/L3c/L5/L6/L7/L8）合成的單一 `system[]` 訊息 |
| **Context preface** | 獨立的 user-role 訊息，放在 user 第一句話之前，承載 T1+T2 dynamic 內容 |
| **T1 / T2 / T3** | dynamic 內容的變動頻率分層；T1 session-stable、T2 decay-tier、T3 per-turn |
| **BP1..BP4** | 4 個 ephemeral cache breakpoint 的位置編號，見 [proposal.md Breakpoint Allocation Strategy](./proposal.md#breakpoint-allocation-strategy) |
| **Anchor message** | compaction 寫入 history 用以代表壓縮歷史的 assistant 訊息（`summary===true`） |
| **Clean turn** | 最後一則 assistant 訊息中所有 `tool_use` part 都已配對 `tool_result` |

## Requirements

### Requirement: System block is purely static within a session

#### Scenario: assembly produces single static system message
- **GIVEN** a session with model M, agent A, and resolved AGENTS.md
- **WHEN** llm.ts assembles system prompt for any turn
- **THEN** `system[]` contains exactly one message
- **AND** that message contains only L1 Driver, L2 Agent, L3c AGENTS, L5 user-system, L6 BOUNDARY, L7 SYSTEM.md, L8 Identity (in this order)
- **AND** that message contains zero text from preload / date / matched routing / skill content

#### Scenario: cross-turn cache key stability for static block
- **GIVEN** session S has produced static system block B at turn N
- **WHEN** turn N+1 begins with the same (model, agent, account, AGENTS.md, SYSTEM.md, user-system, role) tuple
- **THEN** the assembled static system block byte-equals B
- **AND** therefore Anthropic prompt cache reports BP1 hit for that block

### Requirement: Dynamic content lives in user-role context preface, ranked slow-first

#### Scenario: T1 + T2 are emitted as a single preface message before user's first turn text
- **GIVEN** a session with cwd file listing C, README summary R, pinned skill set P, today's date D, active skill set A, summarized skill set S
- **WHEN** a user submits the first message of a session
- **THEN** the outbound `messages[]` contains a user-role context-preface message immediately before the user's text message
- **AND** the preface contains, in order: README summary, cwd listing, pinned skills, `Today's date: D`, active skills, summarized skills
- **AND** the user's text message contains only what the user typed plus T3 inserts (matched routing, ad-hoc context for that turn)

#### Scenario: subsequent turns preserve preface when T1+T2 unchanged
- **GIVEN** the preface from turn 1 contains exact bytes P
- **WHEN** turn 2 is assembled and (cwd listing, README, pinned skills, date, active skills, summarized skills) all unchanged
- **THEN** turn 2's preface message byte-equals P
- **AND** Anthropic prompt cache reports BP2/BP3 hit for the preface

#### Scenario: per-turn matched routing belongs to its triggering turn
- **GIVEN** turn 3's user text contains keyword K that triggers MCP routing to capability `cap-X`
- **WHEN** llm.ts assembles turn 3
- **THEN** `cap-X` routing hint appears appended to turn 3's user text (or as a separate turn-3-scoped context part), NOT in the preface
- **AND** turn 4 with no keyword does not inherit `cap-X` routing

### Requirement: Cache breakpoints are placed at 4 fixed positions

#### Scenario: full breakpoint allocation with all tiers present
- **GIVEN** a turn whose outbound messages include static system block, preface with T1 and T2 segments, and conversation history
- **WHEN** transform.ts applyCaching runs
- **THEN** ephemeral cache_control is placed on:
  - last content block of the static system message (BP1)
  - last content block of the T1 segment within preface (BP2)
  - last content block of the T2 segment within preface (BP3)
  - last content block of the final non-system message (BP4)
- **AND** total breakpoints ≤ 4

#### Scenario: degraded breakpoint allocation when tiers are empty
- **GIVEN** a turn with empty T2 (no active/summarized skills)
- **WHEN** applyCaching runs
- **THEN** BP3 is omitted (saved for future use, not relocated)
- **AND** BP1/BP2/BP4 still placed
- **AND** total breakpoints ≤ 4

### Requirement: Compaction anchor never shadows L7 authority

#### Scenario: narrative anchor is XML-wrapped and imperative-stripped
- **GIVEN** a compaction run whose narrative output text T contains imperative sentences (e.g., "You must…", "Rules:", "The following overrides…")
- **WHEN** the anchor is written to messages stream
- **THEN** the persisted anchor body equals `<prior_context source="narrative">` + sanitized(T) + `</prior_context>`
- **AND** sanitized(T) has imperative-leading lines rewritten to declarative form (e.g., "The agent must X" → "The agent did X")
- **AND** the anchor message has `summary === true`

#### Scenario: llm-agent anchor shares the same sanitization
- **GIVEN** a compaction run that escalates to llm-agent kind producing summary text S
- **WHEN** the anchor is written
- **THEN** the same `<prior_context source="llm-agent">` wrapping + sanitization rules apply

### Requirement: Idle compaction defers when conversation tail is unclean

#### Scenario: defer when last assistant has unmatched tool_use
- **GIVEN** session S where the last assistant message contains a `tool_use` part with id `T1` and no subsequent `tool_result` for `T1`
- **WHEN** idleCompaction is invoked (utilization > threshold)
- **THEN** idleCompaction returns early with telemetry `compaction.idle.deferred` and reason `"unclean-tail"`
- **AND** no anchor is written

#### Scenario: proceed when tail is clean
- **GIVEN** session S where every `tool_use` part in the trailing turns has a matched `tool_result`
- **WHEN** idleCompaction is invoked with utilization > threshold
- **THEN** idleCompaction proceeds to SessionCompaction.run as today

### Requirement: CapabilityLayer rebind failure is loud, not silent

#### Scenario: cross-account reinject failure throws
- **GIVEN** session S with current pinned account A1 (provider family F1) bumps RebindEpoch to E for new account A2 (family F2)
- **WHEN** CapabilityLayer.get(S, E) calls reinject and the loader fails
- **THEN** CapabilityLayer.get throws CrossAccountRebindError with `from=A1, to=A2, failures=[…]`
- **AND** does NOT return a fallback entry from epoch < E

#### Scenario: same-account reinject failure still falls back
- **GIVEN** session S with current pinned account A1 bumps epoch for transient reasons (cache eviction, file read race) without account change
- **WHEN** reinject fails and a previous-epoch entry exists for the same account
- **THEN** CapabilityLayer.get returns the fallback entry with WARN log (existing degraded-mode behavior preserved)

### Requirement: Skill registry stays coherent with anchor

#### Scenario: narrative anchor pins active skills referenced in the compacted span
- **GIVEN** the compacted span includes tool calls or text referencing skill X (X is `active` or `summary`)
- **WHEN** narrative anchor is written
- **THEN** SkillLayerRegistry.pin(X) is called atomically before the anchor write
- **AND** X is exempt from idle decay until explicit unpin

#### Scenario: anchor metadata records L9 snapshot for replay
- **GIVEN** an anchor is written at time T_anchor
- **WHEN** the anchor is persisted
- **THEN** the anchor's metadata field includes `skillSnapshot: { active: [...], summarized: [...], pinned: [...] }` reflecting L9 state at T_anchor

### Requirement: Cache miss diagnostic gates cache-aware compaction

#### Scenario: system prefix churn alone does not trigger compaction
- **GIVEN** the last 3 turns show low cache hit rate but identical conversation length growth pattern
- **AND** static system block bytes changed across those 3 turns (e.g., AGENTS.md edited mid-session)
- **WHEN** shouldCacheAwareCompact evaluates
- **THEN** it returns false with telemetry `compaction.cache_miss_diagnosis.kind = "system-prefix-churn"`
- **AND** no compaction is triggered

#### Scenario: conversation growth with stable system block triggers compaction
- **GIVEN** the last 3 turns show low cache hit rate
- **AND** static system block bytes unchanged across those 3 turns
- **AND** conversation tail tokens > 40K
- **WHEN** shouldCacheAwareCompact evaluates
- **THEN** it returns true with telemetry `compaction.cache_miss_diagnosis.kind = "conversation-growth"`
- **AND** compaction proceeds with current behavior

### Requirement: Plugin hook contract supports dynamic context separately

#### Scenario: existing system transform hook still receives static block
- **GIVEN** a plugin registers `experimental.chat.system.transform`
- **WHEN** the hook fires
- **THEN** the `system` array passed contains only the static block message(s)
- **AND** mutating the array still affects what is sent (existing contract preserved for static content)

#### Scenario: new context transform hook receives dynamic preface
- **GIVEN** a plugin registers `experimental.chat.context.transform`
- **WHEN** the hook fires after preface assembly
- **THEN** the hook receives `{ preface: ContextPrefaceParts, sessionID, model }` where `ContextPrefaceParts` is the structured T1+T2 content
- **AND** mutating the parts affects what gets emitted as the preface message

#### Scenario: legacy plugin behavior is preserved for one release
- **GIVEN** a plugin only registers the old `experimental.chat.system.transform` and tries to inject dynamic content
- **WHEN** the hook fires
- **THEN** any non-static text returned is logged as `WARN: deprecated dynamic injection via system.transform; migrate to context.transform`
- **AND** the injection is honored for backwards compat (NOT silently dropped) for one minor release

## Acceptance Checks

| Check | How verified |
|---|---|
| Static system block byte-equals across consecutive turns when (model, agent, account, AGENTS.md, SYSTEM.md, user-system) unchanged | Unit test: assemble turn N, assemble turn N+1, byte-compare |
| BP1 cache hit ≥ 95% across a 10-turn session with stable account/model | Telemetry assertion in integration test |
| BP2 cache hit ≥ 80% across a 10-turn session with no cwd changes / no skill state transitions | Telemetry assertion |
| BP3 cache hit ≥ 60% across a 10-turn session with no skill decay events | Telemetry assertion |
| Anchor body always starts with `<prior_context` after sanitizer | Unit test: feed adversarial inputs (imperatives, system-like text) |
| idleCompaction defers when fed messages with dangling tool_use | Unit test |
| CapabilityLayer.get throws on cross-account reinject failure | Unit test with synthetic loader failure |
| Skill X pinned after compaction that referenced X | Integration test |
| `shouldCacheAwareCompact` returns false when system block bytes changed but conversation stable | Unit test |
| Plugin hook `experimental.chat.context.transform` is called and mutations are reflected | Integration test |

## Out-of-scope (explicit)

- Conversation history compression algorithm changes (owned by `compaction-redesign`)
- L7 SYSTEM.md content edits
- New cache backends (only ephemeral / cachePoint variants used today)
- Removing the L6 BOUNDARY semantic gate (its physical position can change but its protective role is preserved by sanitizer + structural separation)
- Per-provider cache TTL tuning (5-min default retained)

## Dependencies

- [compaction-redesign](../compaction-redesign/) — kindChain, anchor write contract, cooldown rules
- [compaction-improvements](../compaction-improvements/) — observed-condition table, run() entry point
- [session-rebind-capability-refresh](../session-rebind-capability-refresh/) — RebindEpoch + CapabilityLayer.get
- [docs/prompt_injection.md](../../docs/prompt_injection.md) — must be updated to document the new physical layout while keeping the 9-conceptual-layer authority chain
