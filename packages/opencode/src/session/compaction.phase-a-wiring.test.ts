import { afterEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { SkillLayerRegistry } from "./skill-layer-registry"
import { Memory } from "./memory"
import { Session } from "."
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"

// Phase A wiring tests (Phase A.4 / DD-9 of specs/prompt-cache-and-compaction-hardening).
//
// Coverage strategy:
//   - DD-6 sanitize: covered by 23 unit tests in anchor-sanitizer.test.ts +
//     source inspection of defaultWriteAnchor (compaction.ts ~L1827). The
//     `compactWithSharedContext` call inside defaultWriteAnchor uses a
//     local-scope reference, so namespace-level mocks cannot intercept it
//     without refactoring the production call site. Adding behavioural
//     coverage here would require either (a) module-level mock.module()
//     plumbing or (b) running compactWithSharedContext end-to-end against a
//     real Storage stack — neither of which adds confidence beyond what the
//     unit tests + source inspection already provide.
//   - DD-9 skill auto-pin: covered HERE. annotateAnchorWithSkillState reads
//     SkillLayerRegistry.list (mockable) → SkillLayerRegistry.scanReferences
//     (real, transitive coverage from skill-anchor-binder.test.ts) →
//     SkillLayerRegistry.pinForAnchor (mockable for capture). These tests
//     prove the wiring fires when defaultWriteAnchor runs.

const orig = {
  memoryRead: Memory.read,
  sessionGet: Session.get,
  sessionMessages: Session.messages,
  providerGetModel: Provider.getModel,
  agentGet: Agent.get,
  pluginTrigger: Plugin.trigger,
  cooldown: SessionCompaction.Cooldown.shouldThrottle,
  pinForAnchor: SkillLayerRegistry.pinForAnchor,
  list: SkillLayerRegistry.list,
}

afterEach(() => {
  ;(Memory as any).read = orig.memoryRead
  ;(Session as any).get = orig.sessionGet
  ;(Session as any).messages = orig.sessionMessages
  ;(Provider as any).getModel = orig.providerGetModel
  ;(Agent as any).get = orig.agentGet
  ;(Plugin as any).trigger = orig.pluginTrigger
  ;(SessionCompaction as any).Cooldown.shouldThrottle = orig.cooldown
  ;(SkillLayerRegistry as any).pinForAnchor = orig.pinForAnchor
  ;(SkillLayerRegistry as any).list = orig.list
  SessionCompaction.__test__.resetAnchorWriter()
})

function fakeModel(): Provider.Model {
  return {
    id: "gpt-5.5",
    providerId: "codex",
    limit: { context: 272_000, input: 272_000, output: 32_000 },
    cost: { input: 1 },
  } as any
}

interface SetupOpts {
  sid: string
  summaryText: string
  /** Synthesized anchor message id; required for annotateAnchorWithSkillState
   *  to find a `newAnchorId` post-write. Replace with a real anchor write
   *  once compactWithSharedContext is mockable end-to-end. */
  anchorMsgId: string
}

function setupMocks(opts: SetupOpts) {
  const mem: Memory.SessionMemory = {
    sessionID: opts.sid,
    version: 1,
    updatedAt: 1,
    turnSummaries: [
      {
        turnIndex: 0,
        userMessageId: "msg_u1",
        endedAt: 1,
        text: opts.summaryText,
        modelID: "gpt-5.5",
        providerId: "codex",
      },
    ],
    fileIndex: [],
    actionLog: [],
    lastCompactedAt: null,
    rawTailBudget: 5,
  }
  ;(Memory as any).read = mock(async () => mem)
  ;(Session as any).get = mock(async () => ({
    execution: { providerId: "codex", modelID: "gpt-5.5", accountId: "acc-A" },
  }))
  // anchor 60s old → Cooldown gate would let it through even without bypass
  // dialog-replay-redaction: include a user/assistant tail AFTER the anchor so
  // the new tryNarrative path produces a body containing opts.summaryText
  // (skill detector matches on the rendered body).
  const anchorMessages = [
    {
      info: {
        id: opts.anchorMsgId,
        role: "assistant" as const,
        sessionID: opts.sid,
        summary: true,
        time: { created: Date.now() - 60_000 },
      },
      parts: [],
    },
    {
      info: {
        id: "msg_synth_u",
        sessionID: opts.sid,
        role: "user" as const,
        time: { created: Date.now() - 30_000 },
        agent: "default",
        model: { providerId: "codex", modelID: "gpt-5.5" },
      },
      parts: [
        {
          id: "prt_u",
          messageID: "msg_synth_u",
          sessionID: opts.sid,
          type: "text" as const,
          text: "user prompt",
          time: { start: 0, end: 0 },
        },
      ],
    },
    {
      info: {
        id: "msg_synth_a",
        sessionID: opts.sid,
        role: "assistant" as const,
        parentID: "msg_synth_u",
        modelID: "gpt-5.5",
        providerId: "codex",
        mode: "primary",
        agent: "default",
        path: { cwd: ".", root: "." },
        summary: false,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop" as const,
        time: { created: Date.now() - 25_000, completed: Date.now() - 25_000 },
      },
      parts: [
        {
          id: "prt_a",
          messageID: "msg_synth_a",
          sessionID: opts.sid,
          type: "text" as const,
          text: opts.summaryText,
          time: { start: 0, end: 0 },
        },
      ],
    },
  ]
  ;(Session as any).messages = mock(async () => anchorMessages)
  ;(Provider as any).getModel = mock(async () => fakeModel())
  ;(SessionCompaction as any).Cooldown.shouldThrottle = mock(async () => false)

  // Replace _writeAnchor with a wrapper that delegates to the real
  // defaultWriteAnchor logic by importing the helpers and re-running them.
  // Direct delegation isn't possible (defaultWriteAnchor is a closure), so we
  // use setAnchorWriter to capture the input and trigger annotateAnchorWithSkillState
  // ourselves through the registry. Tests below assert against pinForAnchor
  // calls, which are the wiring proof point.
}

describe("Phase A wiring — DD-9 skill auto-pin via defaultWriteAnchor", () => {
  it("pinForAnchor IS called when summary references an active skill (word-boundary match)", async () => {
    const sid = "ses_dd9_match"
    const anchorId = "msg_anchor_dd9_match"
    ;(SkillLayerRegistry as any).list = mock((s: string) => {
      if (s !== sid) return []
      return [
        {
          sessionID: sid,
          name: "foo-skill",
          desiredState: "full",
          runtimeState: "active",
          pinned: false,
          lastReason: "",
          lastUsedAt: Date.now(),
        },
      ]
    })
    const pinCalls: { name: string; anchorId: string; reason: string }[] = []
    ;(SkillLayerRegistry as any).pinForAnchor = mock(
      (_s: string, n: string, a: string, r: string) => {
        pinCalls.push({ name: n, anchorId: a, reason: r })
      },
    )

    setupMocks({
      sid,
      summaryText: "We used foo-skill to handle the docx upload",
      anchorMsgId: anchorId,
    })

    const result = await SessionCompaction.run({
      sessionID: sid,
      observed: "overflow",
      step: 1,
    })

    expect(result).toBe("continue")
    expect(pinCalls).toHaveLength(1)
    expect(pinCalls[0].name).toBe("foo-skill")
    expect(pinCalls[0].anchorId).toBe(anchorId)
    expect(pinCalls[0].reason).toBe("referenced-by-anchor")
  })

  it("pinForAnchor NOT called when summary doesn't mention any known skill", async () => {
    const sid = "ses_dd9_nomatch"
    ;(SkillLayerRegistry as any).list = mock((s: string) => {
      if (s !== sid) return []
      return [
        {
          sessionID: sid,
          name: "bar-skill",
          desiredState: "full",
          runtimeState: "active",
          pinned: false,
          lastReason: "",
          lastUsedAt: Date.now(),
        },
      ]
    })
    const pinCalls: any[] = []
    ;(SkillLayerRegistry as any).pinForAnchor = mock((_s: string, n: string) => {
      pinCalls.push({ name: n })
    })

    setupMocks({
      sid,
      summaryText: "Did some unrelated work and finished",
      anchorMsgId: "msg_anchor_dd9_nomatch",
    })

    await SessionCompaction.run({ sessionID: sid, observed: "overflow", step: 1 })

    expect(pinCalls).toHaveLength(0)
  })

  it("substring-only match does NOT pin (word-boundary required)", async () => {
    const sid = "ses_dd9_substring"
    ;(SkillLayerRegistry as any).list = mock(() => [
      {
        sessionID: sid,
        name: "doc",
        desiredState: "full",
        runtimeState: "active",
        pinned: false,
        lastReason: "",
        lastUsedAt: Date.now(),
      },
    ])
    const pinCalls: any[] = []
    ;(SkillLayerRegistry as any).pinForAnchor = mock((_s: string, n: string) => {
      pinCalls.push({ name: n })
    })

    setupMocks({
      sid,
      summaryText: "Hooked into docxmcp dispatcher",
      anchorMsgId: "msg_anchor_dd9_sub",
    })

    await SessionCompaction.run({ sessionID: sid, observed: "overflow", step: 1 })

    expect(pinCalls).toHaveLength(0)
  })

  it("multiple matched skills all get pinned in one anchor", async () => {
    const sid = "ses_dd9_multi"
    const anchorId = "msg_anchor_dd9_multi"
    ;(SkillLayerRegistry as any).list = mock(() => [
      {
        sessionID: sid,
        name: "alpha-skill",
        desiredState: "full",
        runtimeState: "active",
        pinned: false,
        lastReason: "",
        lastUsedAt: Date.now(),
      },
      {
        sessionID: sid,
        name: "beta-skill",
        desiredState: "full",
        runtimeState: "active",
        pinned: false,
        lastReason: "",
        lastUsedAt: Date.now(),
      },
      {
        sessionID: sid,
        name: "gamma-skill",
        desiredState: "full",
        runtimeState: "active",
        pinned: false,
        lastReason: "",
        lastUsedAt: Date.now(),
      },
    ])
    const pinCalls: { name: string }[] = []
    ;(SkillLayerRegistry as any).pinForAnchor = mock((_s: string, n: string) => {
      pinCalls.push({ name: n })
    })

    setupMocks({
      sid,
      summaryText: "Used alpha-skill and gamma-skill but not the third",
      anchorMsgId: anchorId,
    })

    await SessionCompaction.run({ sessionID: sid, observed: "overflow", step: 1 })

    expect(pinCalls).toHaveLength(2)
    const names = pinCalls.map((c) => c.name).sort()
    expect(names).toEqual(["alpha-skill", "gamma-skill"])
  })
})
