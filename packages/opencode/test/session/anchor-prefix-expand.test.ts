/**
 * compaction-fix Phase 2 — anchor-prefix expansion unit tests.
 *
 * Coverage map vs design.md decisions:
 *   - DD-9 chain identity match → "expands when chainBinding matches"
 *   - DD-9 chain identity mismatch → "skips on chain-mismatch"
 *   - DD-10 message item expansion → "expands codex message items into user-role messages"
 *   - DD-10 mixed unmappable items → "wraps unmappable items into single JSON message"
 *   - DD-12 missing serverCompactedItems → "skips when no server items"
 *   - DD-12 empty array → "skips on empty items"
 *   - DD-12 no chain binding → "skips when chainBinding absent"
 *   - DD-12 no compaction part → "skips when anchor has no compaction part"
 */

import { describe, expect, test } from "bun:test"
import { expandAnchorCompactedPrefix } from "../../src/session/anchor-prefix-expand"
import type { MessageV2 } from "../../src/session/message-v2"

let nextId = 0
function id(prefix: string): string {
  return `${prefix}_${(++nextId).toString(36).padStart(8, "0")}`
}

function userMessage(text: string, accountId = "acct_default"): MessageV2.WithParts {
  const messageID = id("msg")
  const sessionID = "ses_test"
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerId: "codex", modelID: "gpt-5.5", accountId },
    } as MessageV2.User,
    parts: [
      {
        id: id("prt"),
        sessionID,
        messageID,
        type: "text",
        text,
      } as MessageV2.TextPart,
    ],
  }
}

function anchorWithMetadata(meta: Record<string, unknown>): MessageV2.WithParts {
  const messageID = id("msg")
  const sessionID = "ses_test"
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID: id("msg"),
      modelID: "gpt-5.5",
      providerId: "codex",
      mode: "build",
      agent: "default",
      path: { cwd: "/", root: "/" },
      summary: true,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageV2.Assistant,
    parts: [
      {
        id: id("prt"),
        sessionID,
        messageID,
        type: "text",
        text: "[anchor summary]",
      } as MessageV2.TextPart,
      {
        id: id("prt"),
        sessionID,
        messageID,
        type: "compaction",
        auto: false,
        metadata: meta,
      } as unknown as MessageV2.Part,
    ],
  }
}

const codexMessageItem = (text: string, role: "user" | "assistant" = "user") => ({
  type: "message" as const,
  role,
  content: [{ type: "input_text", text }],
})

const ctxMatch = {
  sessionID: "ses_test",
  accountId: "acct_default",
  modelID: "gpt-5.5",
}

describe("expandAnchorCompactedPrefix — happy path (DD-10)", () => {
  test("expands codex message items into synthetic user-role messages", () => {
    const messages: MessageV2.WithParts[] = [
      anchorWithMetadata({
        serverCompactedItems: [
          codexMessageItem("user said earlier: setup the database"),
          codexMessageItem("assistant did: created schema", "assistant"),
          codexMessageItem("user said: run migrations"),
        ],
        chainBinding: { accountId: "acct_default", modelId: "gpt-5.5", capturedAt: Date.now() },
      }),
      userMessage("current question"),
    ]
    const result = expandAnchorCompactedPrefix(messages, ctxMatch)
    if (!result.applied) throw new Error(`expected applied=true; got reason=${result.reason}`)
    expect(result.expandedItemCount).toBe(3)
    expect(result.messagesAdded).toBe(3)
    expect(result.mappableItemCount).toBe(3)
    expect(result.unmappableItemCount).toBe(0)
    // Original anchor dropped, 3 synthetic user messages + original userMessage
    expect(result.messages.length).toBe(4)
    expect(result.messages[0].info.role).toBe("user")
    const firstText = (result.messages[0].parts[0] as MessageV2.TextPart).text
    expect(firstText).toContain("setup the database")
    // Last message is the user's current question (untouched)
    expect((result.messages[3].parts[0] as MessageV2.TextPart).text).toBe("current question")
  })

  test("wraps unmappable items into single JSON wrapper message (DD-10 + DD-12)", () => {
    const messages: MessageV2.WithParts[] = [
      anchorWithMetadata({
        serverCompactedItems: [
          codexMessageItem("readable text"),
          { type: "function_call", name: "read_file", arguments: '{"path":"x.ts"}', call_id: "call_abc" },
          { type: "function_call_output", call_id: "call_abc", output: "..." },
        ],
        chainBinding: { accountId: "acct_default", modelId: "gpt-5.5", capturedAt: Date.now() },
      }),
      userMessage("current"),
    ]
    const result = expandAnchorCompactedPrefix(messages, ctxMatch)
    if (!result.applied) throw new Error(`expected applied=true; got reason=${result.reason}`)
    expect(result.mappableItemCount).toBe(1)
    expect(result.unmappableItemCount).toBe(2)
    // 1 mappable user message + 1 wrapper for unmappable + 1 original user
    expect(result.messages.length).toBe(3)
    const wrapperText = (result.messages[1].parts[0] as MessageV2.TextPart).text
    expect(wrapperText).toContain("[compacted prior tool history")
    expect(wrapperText).toContain("function_call")
    expect(wrapperText).toContain("read_file")
  })
})

describe("expandAnchorCompactedPrefix — skip paths (DD-12)", () => {
  test("skips when anchor has no compaction part", () => {
    const messageID = id("msg")
    const sessionID = "ses_test"
    const messages: MessageV2.WithParts[] = [
      {
        info: {
          id: messageID,
          sessionID,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          parentID: id("msg"),
          modelID: "gpt-5.5",
          providerId: "codex",
          mode: "build",
          agent: "default",
          path: { cwd: "/", root: "/" },
          summary: true,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as MessageV2.Assistant,
        parts: [
          {
            id: id("prt"),
            sessionID,
            messageID,
            type: "text",
            text: "summary",
          } as MessageV2.TextPart,
        ],
      },
      userMessage("current"),
    ]
    const result = expandAnchorCompactedPrefix(messages, ctxMatch)
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.reason).toBe("no-compaction-part")
  })

  test("skips when serverCompactedItems is missing", () => {
    const messages: MessageV2.WithParts[] = [
      anchorWithMetadata({
        chainBinding: { accountId: "acct_default", modelId: "gpt-5.5", capturedAt: Date.now() },
      }),
      userMessage("current"),
    ]
    const result = expandAnchorCompactedPrefix(messages, ctxMatch)
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.reason).toBe("no-server-items")
  })

  test("skips when serverCompactedItems is empty", () => {
    const messages: MessageV2.WithParts[] = [
      anchorWithMetadata({
        serverCompactedItems: [],
        chainBinding: { accountId: "acct_default", modelId: "gpt-5.5", capturedAt: Date.now() },
      }),
      userMessage("current"),
    ]
    const result = expandAnchorCompactedPrefix(messages, ctxMatch)
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.reason).toBe("items-empty")
  })

  test("skips when chainBinding is missing", () => {
    const messages: MessageV2.WithParts[] = [
      anchorWithMetadata({
        serverCompactedItems: [codexMessageItem("text")],
      }),
      userMessage("current"),
    ]
    const result = expandAnchorCompactedPrefix(messages, ctxMatch)
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.reason).toBe("no-chain-binding")
  })

  test("skips on chainBinding accountId mismatch (DD-9)", () => {
    const messages: MessageV2.WithParts[] = [
      anchorWithMetadata({
        serverCompactedItems: [codexMessageItem("text")],
        chainBinding: { accountId: "acct_OTHER", modelId: "gpt-5.5", capturedAt: Date.now() },
      }),
      userMessage("current"),
    ]
    const result = expandAnchorCompactedPrefix(messages, ctxMatch)
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.reason).toBe("chain-mismatch")
  })

  test("skips on chainBinding modelId mismatch (DD-9)", () => {
    const messages: MessageV2.WithParts[] = [
      anchorWithMetadata({
        serverCompactedItems: [codexMessageItem("text")],
        chainBinding: { accountId: "acct_default", modelId: "gpt-5.4", capturedAt: Date.now() },
      }),
      userMessage("current"),
    ]
    const result = expandAnchorCompactedPrefix(messages, ctxMatch)
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.reason).toBe("chain-mismatch")
  })

  test("skips when first message is not assistant anchor", () => {
    const messages: MessageV2.WithParts[] = [userMessage("hi"), userMessage("current")]
    const result = expandAnchorCompactedPrefix(messages, ctxMatch)
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.reason).toBe("no-anchor")
  })

  test("skips on empty input", () => {
    const result = expandAnchorCompactedPrefix([], ctxMatch)
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.reason).toBe("no-anchor")
  })
})
