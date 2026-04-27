import { afterEach, describe, expect, it, mock } from "bun:test"
import { deriveObservedCondition, findMostRecentAnchor } from "./prompt"
import { SessionCompaction } from "./compaction"
import { Memory } from "./memory"
import type { MessageV2 } from "./message-v2"

const originalCooldown = SessionCompaction.Cooldown.shouldThrottle
const originalMemoryRead = Memory.read

afterEach(() => {
  ;(SessionCompaction.Cooldown as any).shouldThrottle = originalCooldown
  ;(Memory as any).read = originalMemoryRead
})

function makeAnchor(
  providerId: string,
  modelID: string,
  accountId: string | undefined,
): MessageV2.WithParts {
  return {
    info: {
      id: "msg_anchor",
      role: "assistant",
      sessionID: "ses_test",
      parentID: "msg_u1",
      mode: "compaction",
      agent: "compaction",
      summary: true,
      modelID,
      providerId,
      accountId,
      time: { created: 1, completed: 1 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      path: { cwd: "/tmp", root: "/tmp" },
    } as MessageV2.Assistant,
    parts: [],
  }
}

function makeUserText(id: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id,
      role: "user",
      sessionID: "ses_test",
      agent: "default",
      model: { providerId: "codex", modelID: "gpt-5.5" },
      time: { created: 1 },
    } as MessageV2.User,
    parts: [
      {
        id: `${id}_p`,
        messageID: id,
        sessionID: "ses_test",
        type: "text",
        text,
      } as any,
    ],
  }
}

function makeAssistantFinished(
  id: string,
  totalTokens: number,
  providerId = "codex",
  accountId: string | undefined = "acc-A",
): MessageV2.WithParts {
  return {
    info: {
      id,
      role: "assistant",
      sessionID: "ses_test",
      parentID: "msg_u1",
      mode: "default",
      agent: "default",
      modelID: "gpt-5.5",
      providerId,
      accountId,
      finish: "stop",
      time: { created: 1, completed: 2 },
      cost: 0,
      tokens: { input: totalTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: totalTokens },
      path: { cwd: "/tmp", root: "/tmp" },
    } as MessageV2.Assistant,
    parts: [],
  }
}

describe("findMostRecentAnchor", () => {
  it("returns null when no anchor present", () => {
    const msgs = [makeUserText("msg_u1", "hi"), makeAssistantFinished("msg_a1", 100)]
    expect(findMostRecentAnchor(msgs)).toBeNull()
  })

  it("returns most recent anchor's identity", () => {
    const msgs = [
      makeAnchor("codex", "gpt-5.5", "acc-A"),
      makeUserText("msg_u2", "hi"),
      makeAnchor("claude", "claude-4.6", "acc-B"),
      makeUserText("msg_u3", "hello"),
    ]
    const anchor = findMostRecentAnchor(msgs)
    expect(anchor?.providerId).toBe("claude")
    expect(anchor?.accountId).toBe("acc-B")
  })

  it("ignores non-summary assistant messages", () => {
    const msgs = [
      makeAnchor("codex", "gpt-5.5", "acc-A"),
      makeAssistantFinished("msg_a2", 100, "claude", "acc-B"),
    ]
    const anchor = findMostRecentAnchor(msgs)
    expect(anchor?.providerId).toBe("codex") // not the regular assistant
  })
})

describe("deriveObservedCondition (DD-1 state-driven)", () => {
  function commonInput(overrides: Partial<Parameters<typeof deriveObservedCondition>[0]> = {}) {
    return {
      sessionID: "ses_test",
      step: 5,
      msgs: [],
      lastFinished: undefined,
      pinnedProviderId: "codex",
      pinnedAccountId: "acc-A",
      hasUnprocessedCompactionRequest: false,
      parentID: undefined,
      isOverflow: async () => false,
      isCacheAware: async () => false,
      ...overrides,
    }
  }

  it("returns null when no condition is observed", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    expect(await deriveObservedCondition(commonInput())).toBeNull()
  })

  it("returns null for subagent sessions (parentID set) — INV: subagents do not self-compact", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    expect(
      await deriveObservedCondition(commonInput({ parentID: "ses_parent" })),
    ).toBeNull()
  })

  it("returns null when cooldown blocks", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => true)
    expect(
      await deriveObservedCondition(
        commonInput({ hasUnprocessedCompactionRequest: true }),
      ),
    ).toBeNull()
  })

  it("manual takes priority over all other observed conditions", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        hasUnprocessedCompactionRequest: true,
        msgs: [makeAnchor("claude", "claude-4.6", "acc-X")], // would otherwise be provider-switched
        lastFinished: makeAssistantFinished("msg_a1", 999_999).info as MessageV2.Assistant,
        isOverflow: async () => true,
      }),
    )
    expect(result).toBe("manual")
  })

  it("provider-switched when pinned providerId differs from last anchor", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        pinnedProviderId: "claude",
        msgs: [makeAnchor("codex", "gpt-5.5", "acc-A")],
      }),
    )
    expect(result).toBe("provider-switched")
  })

  it("rebind when pinned accountId differs from last anchor (same provider)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        pinnedProviderId: "codex",
        pinnedAccountId: "acc-B",
        msgs: [makeAnchor("codex", "gpt-5.5", "acc-A")],
      }),
    )
    expect(result).toBe("rebind")
  })

  it("provider-switched takes priority over rebind when both differ", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        pinnedProviderId: "claude",
        pinnedAccountId: "acc-B",
        msgs: [makeAnchor("codex", "gpt-5.5", "acc-A")],
      }),
    )
    expect(result).toBe("provider-switched")
  })

  it("no rebind detection when no anchor exists", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        msgs: [makeUserText("msg_u1", "hi"), makeAssistantFinished("msg_a1", 100)],
      }),
    )
    expect(result).toBeNull()
  })

  it("overflow when lastFinished present and isOverflow predicate returns true", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        lastFinished: makeAssistantFinished("msg_a1", 999_999).info as MessageV2.Assistant,
        isOverflow: async () => true,
      }),
    )
    expect(result).toBe("overflow")
  })

  it("cache-aware when overflow false but cache-aware predicate returns true", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        lastFinished: makeAssistantFinished("msg_a1", 200_000).info as MessageV2.Assistant,
        isOverflow: async () => false,
        isCacheAware: async () => true,
      }),
    )
    expect(result).toBe("cache-aware")
  })

  it("identity drift takes priority over token pressure", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        pinnedAccountId: "acc-B",
        msgs: [makeAnchor("codex", "gpt-5.5", "acc-A")],
        lastFinished: makeAssistantFinished("msg_a1", 999_999).info as MessageV2.Assistant,
        isOverflow: async () => true,
      }),
    )
    expect(result).toBe("rebind")
  })
})
