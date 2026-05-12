---
date: 2026-05-12
summary: "Data-plane gap discovered: PendingInjectionStore had no consumer"
---

# Data-plane gap discovered: PendingInjectionStore had no consumer

During live verification of Phase C on `ses_1e56ed3f9ffebv4AaWOlcPLz20` (account switch at ~19:56), control-plane telemetry fired correctly:
- chain.commitment.captured  digestEntryCount=5
- session.rebind  chainBreakClass=SS-break
- chain.init.injected  bodyCharCount=779

But inspection showed `PendingInjectionStore.consume` had NO caller. The marker was being WRITTEN by Continuation.run but never READ by the prompt builder. The chain.init.injected event was firing accurately at the control-plane level, but the data-plane prompt body never contained the `<chain_init_notice>` fragment — i.e. the telemetry was lying.

Hotfix `a89fef9c9` applied directly on the test branch (per user instruction to avoid another beta→test fetch-back cycle) added the consumer in llm.ts immediately before `assembleBundles`. After daemon restart, fragmentIds list confirmed:
```
[agents_md:global, agents_md:project, amnesia_notice, chain_init_notice, environment_context]
```
End-to-end verified.

**Lesson:** "telemetry says X happened" ≠ "X actually reached the AI". For prompt-injection-style features, control plane + data plane must both be verified before declaring done. Saving this as a feedback-class memory entry.</body>
