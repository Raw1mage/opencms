/**
 * Tests for the conversation cache-breakpoint alignment + 4-breakpoint budget.
 *
 * plan provider-claude_conversation-cache-breakpoint (F1 / DD-2 / DD-8):
 *  - applyConversationCacheBreakpoint marks the last block of the last TWO
 *    messages (official `TF5` marker set), skipping a thinking/redacted_thinking
 *    last block (official `OF5`).
 *  - convertTools no longer carries a cache_control breakpoint; the budget is
 *    tools(0) + system(2: identity+static) + conversation(2) = 4 ≤ Anthropic max.
 *
 * See issues/bug_20260602_claude_cli_rapid_narrative_compaction_cascade.md §3.x.
 */
import { describe, expect, test } from "bun:test"
import {
  applyConversationCacheBreakpoint,
  convertTools,
  convertSystemBlocks,
} from "../src/convert.js"
import type { AnthropicMessage, AnthropicContentBlock } from "../src/convert.js"
import type { LanguageModelV2FunctionTool } from "@ai-sdk/provider"

const mkMsg = (role: "user" | "assistant", blocks: AnthropicContentBlock[]): AnthropicMessage => ({
  role,
  content: blocks,
})
const ccCount = (m: AnthropicMessage): number =>
  Array.isArray(m.content) ? m.content.filter((b) => b.cache_control != null).length : 0
const totalConvCC = (messages: AnthropicMessage[]): number =>
  messages.reduce((n, m) => n + ccCount(m), 0)

describe("applyConversationCacheBreakpoint — official TF5 two-breakpoint alignment", () => {
  test("marks last block of the last TWO messages, nothing earlier", () => {
    const messages: AnthropicMessage[] = [
      mkMsg("user", [{ type: "text", text: "m0" }]),
      mkMsg("assistant", [{ type: "text", text: "m1" }]),
      mkMsg("user", [{ type: "tool_result", tool_use_id: "t", content: "m2" }]),
    ]
    applyConversationCacheBreakpoint(messages, true)
    expect(ccCount(messages[0]!)).toBe(0)
    expect(ccCount(messages[1]!)).toBe(1) // second-to-last
    expect(ccCount(messages[2]!)).toBe(1) // last
    expect(totalConvCC(messages)).toBe(2)
  })

  test("single message → exactly one breakpoint", () => {
    const messages: AnthropicMessage[] = [mkMsg("user", [{ type: "text", text: "only" }])]
    applyConversationCacheBreakpoint(messages, true)
    expect(ccCount(messages[0]!)).toBe(1)
    expect(totalConvCC(messages)).toBe(1)
  })

  test("a thinking last-block is skipped (official OF5 exclusion)", () => {
    const messages: AnthropicMessage[] = [
      mkMsg("user", [{ type: "text", text: "m0" }]),
      // assistant whose LAST block is thinking → this message gets no breakpoint
      mkMsg("assistant", [{ type: "thinking", thinking: "...", signature: "s" }]),
      mkMsg("user", [{ type: "text", text: "m2" }]),
    ]
    applyConversationCacheBreakpoint(messages, true)
    expect(ccCount(messages[2]!)).toBe(1) // last marked
    expect(ccCount(messages[1]!)).toBe(0) // thinking last-block skipped
  })

  test("breakpoint sits on the LAST block; leading thinking/text untouched", () => {
    const assistant = mkMsg("assistant", [
      { type: "thinking", thinking: "t", signature: "s" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "u", name: "x", input: {} },
    ])
    const messages: AnthropicMessage[] = [
      assistant,
      mkMsg("user", [{ type: "tool_result", tool_use_id: "u", content: "ok" }]),
    ]
    applyConversationCacheBreakpoint(messages, true)
    const blocks = assistant.content as AnthropicContentBlock[]
    expect(blocks[blocks.length - 1]!.cache_control).not.toBeNull()
    expect(blocks[blocks.length - 1]!.cache_control).toBeDefined()
    expect(blocks[0]!.cache_control).toBeUndefined() // thinking
    expect(blocks[1]!.cache_control).toBeUndefined() // text
  })

  test("caching disabled → no breakpoints", () => {
    const messages: AnthropicMessage[] = [
      mkMsg("user", [{ type: "text", text: "x" }]),
      mkMsg("user", [{ type: "text", text: "y" }]),
    ]
    applyConversationCacheBreakpoint(messages, false)
    expect(totalConvCC(messages)).toBe(0)
  })

  test("empty messages → no-op", () => {
    const messages: AnthropicMessage[] = []
    applyConversationCacheBreakpoint(messages, true)
    expect(messages).toHaveLength(0)
  })
})

// RCA §12 (upstream-confirmed): official `TF5` `f()` skips injected api_system
// messages when placing breakpoints. opencms injects an ephemeral context preface
// as a role:"user" message right before the last user turn; without skipping it the
// second breakpoint lands on the volatile preface (re-spliced every turn) → no stable
// read-hit → cache thrash (45% cold, full conversation rewrites). The finder must skip
// isContextPreface messages so both breakpoints land on stable real conversation.
describe("applyConversationCacheBreakpoint — skips the ephemeral context preface (RCA §12)", () => {
  const preface = (text: string): AnthropicMessage => ({
    role: "user",
    content: [{ type: "text", text }],
    isContextPreface: true,
  })

  test("preface as 2nd-to-last is skipped; breakpoints land on real conversation", () => {
    const messages: AnthropicMessage[] = [
      mkMsg("user", [{ type: "text", text: "m0" }]),
      mkMsg("assistant", [{ type: "text", text: "m1-real-2nd-to-last" }]),
      preface("ephemeral per-turn context"),
      mkMsg("user", [{ type: "text", text: "m3-last-user" }]),
    ]
    applyConversationCacheBreakpoint(messages, true)
    expect(ccCount(messages[3]!)).toBe(1) // last real conversation message
    expect(ccCount(messages[2]!)).toBe(0) // PREFACE skipped — the bug was a cc here
    expect(ccCount(messages[1]!)).toBe(1) // real second-to-last (found by skipping preface)
    expect(ccCount(messages[0]!)).toBe(0)
    expect(totalConvCC(messages)).toBe(2)
  })

  test("multiple consecutive prefaces are all skipped", () => {
    const messages: AnthropicMessage[] = [
      mkMsg("user", [{ type: "text", text: "real-a" }]),
      mkMsg("assistant", [{ type: "text", text: "real-b" }]),
      preface("p1"),
      preface("p2"),
    ]
    applyConversationCacheBreakpoint(messages, true)
    expect(ccCount(messages[2]!)).toBe(0)
    expect(ccCount(messages[3]!)).toBe(0)
    expect(ccCount(messages[1]!)).toBe(1) // last real
    expect(ccCount(messages[0]!)).toBe(1) // second-to-last real
  })

  test("only prefaces → no breakpoints (no real conversation to mark)", () => {
    const messages: AnthropicMessage[] = [preface("p1"), preface("p2")]
    applyConversationCacheBreakpoint(messages, true)
    expect(totalConvCC(messages)).toBe(0)
  })
})

describe("cache breakpoint budget — DD-8 (tools 0 + system 2 + conversation 2 = 4)", () => {
  const tools = [
    { type: "function", name: "a", description: "", inputSchema: {} },
    { type: "function", name: "b", description: "", inputSchema: {} },
  ] as unknown as LanguageModelV2FunctionTool[]

  test("convertTools places NO cache_control (redundant tools breakpoint removed)", () => {
    const out = convertTools(tools, true)!
    expect(out).toHaveLength(2)
    expect(out.every((t) => t.cache_control == null)).toBe(true)
  })

  test("system blocks keep cache_control — the ~33K stable floor is preserved", () => {
    const blocks = convertSystemBlocks({ systemText: "SYSTEM", enableCaching: true, identity: "ID" })
    // Mode C: identity (org) + systemText (org) = 2 cached system breakpoints
    expect(blocks.filter((b) => b.cache_control != null).length).toBe(2)
  })

  test("end-to-end: total cache_control breakpoints == 4 and ≤ Anthropic max of 4", () => {
    const systemBlocks = convertSystemBlocks({ systemText: "SYSTEM", enableCaching: true, identity: "ID" })
    const toolsOut = convertTools(tools, true)!
    const messages: AnthropicMessage[] = [
      mkMsg("user", [{ type: "text", text: "m0" }]),
      mkMsg("assistant", [{ type: "text", text: "m1" }]),
      mkMsg("user", [{ type: "text", text: "m2" }]),
    ]
    applyConversationCacheBreakpoint(messages, true)

    const systemCC = systemBlocks.filter((b) => b.cache_control != null).length
    const toolsCC = toolsOut.filter((t) => t.cache_control != null).length
    const convCC = totalConvCC(messages)

    expect(toolsCC).toBe(0)
    expect(systemCC).toBe(2)
    expect(convCC).toBe(2)
    expect(systemCC + toolsCC + convCC).toBe(4)
    expect(systemCC + toolsCC + convCC).toBeLessThanOrEqual(4)
  })
})
