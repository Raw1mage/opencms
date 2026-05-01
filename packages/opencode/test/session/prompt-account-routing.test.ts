import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { LLM } from "../../src/session/llm"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"
import { SessionCompaction } from "../../src/session/compaction"

describe("session.prompt account routing", () => {
  afterEach(() => {
    mock.restore()
  })

  test("passes session-scoped accountId into LLM stream input", async () => {
    let seenAccountId: string | undefined

    const streamSpy = spyOn(LLM, "stream").mockImplementation(async (input) => {
      seenAccountId = input.accountId
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start", id: "text-1" }
          yield { type: "text-delta", id: "text-1", text: "ok" }
          yield { type: "text-end", id: "text-1" }
          yield {
            type: "finish-step",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            providerMetadata: {},
          }
          yield { type: "finish" }
        })(),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.4",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: {
            providerId: "openai",
            modelID: "gpt-5.4",
            accountId: "openai-subscription-pincyluo-gmail-com",
          },
          parts: [{ type: "text", text: "Check routing" }],
        })
      },
    })

    expect(streamSpy).toHaveBeenCalled()
    expect(seenAccountId).toBe("openai-subscription-pincyluo-gmail-com")
  }, 30_000)

  test("stops safely when a runloop has no user message boundary", async () => {
    const streamSpy = spyOn(LLM, "stream")

    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const assistant = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: Identifier.ascending("message"),
          mode: "compaction",
          agent: "compaction",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-5.4",
          providerId: "openai",
          time: { created: Date.now() },
          finish: "stop",
        })

        const result = await SessionPrompt.loop(session.id)
        expect(result.info.id).toBe(assistant.id)
      },
    })

    expect(streamSpy).not.toHaveBeenCalled()
  })

  test("surfaces previous-turn context budget on the latest user message", async () => {
    let calls = 0
    let secondCallMessages: unknown[] | undefined

    spyOn(LLM, "stream").mockImplementation(async (input) => {
      calls++
      if (calls === 2) secondCallMessages = input.messages as unknown[]
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start", id: "text-1" }
          yield { type: "text-delta", id: "text-1", text: "ok" }
          yield { type: "text-end", id: "text-1" }
          yield {
            type: "finish-step",
            finishReason: "stop",
            usage: { inputTokens: 188137, outputTokens: 1, totalTokens: 188138, cachedInputTokens: 0 },
            providerMetadata: {},
          }
          yield { type: "finish" }
        })(),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.4",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerId: "openai", modelID: "gpt-5.4" },
          parts: [{ type: "text", text: "first" }],
        })
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerId: "openai", modelID: "gpt-5.4" },
          parts: [{ type: "text", text: "second" }],
        })
      },
    })

    const latestUser = [...(secondCallMessages ?? [])]
      .reverse()
      .find((message) => (message as { role?: string }).role === "user") as
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined
    const budgetText = latestUser?.content?.find(
      (part) => part.type === "text" && part.text?.includes("<context_budget>"),
    )?.text
    expect(budgetText).toContain("window: 272000")
    expect(budgetText).toContain("used: 188137")
    expect(budgetText).toContain("status: yellow")
    expect(budgetText).toContain("as_of: end_of_turn_N-1")
  }, 30_000)

  test("routes parent empty-response self-heal through compaction instead of retry nudge", async () => {
    const compactionRun = spyOn(SessionCompaction, "run").mockImplementation(async () => "continue")
    spyOn(LLM, "stream").mockImplementation(async () => {
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start", id: "text-1" }
          yield { type: "text-delta", id: "text-1", text: "recovered" }
          yield { type: "text-end", id: "text-1" }
          yield {
            type: "finish-step",
            finishReason: "stop",
            usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101 },
            providerMetadata: {},
          }
          yield { type: "finish" }
        })(),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await using tmp = await tmpdir({
      git: true,
      config: { agent: { build: { model: "openai/gpt-5.4" } } },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerId: "openai", modelID: "gpt-5.4" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user1.id,
          sessionID: session.id,
          type: "text",
          text: "first",
        })
        const assistant1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: user1.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 188137, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-5.4",
          providerId: "openai",
          time: { created: Date.now() },
          finish: "stop",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant1.id,
          sessionID: session.id,
          type: "text",
          text: "ok",
        })
        const user2 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerId: "openai", modelID: "gpt-5.4" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user2.id,
          sessionID: session.id,
          type: "text",
          text: "second",
        })
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: user2.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-5.4",
          providerId: "openai",
          time: { created: Date.now() },
          finish: "unknown",
        })

        await SessionPrompt.loop(session.id)
        const messages = await Session.messages({ sessionID: session.id })
        const nudge = messages.findLast(
          (message) =>
            message.info.role === "user" &&
            message.parts.some((part) => part.type === "text" && part.text.includes("runtime-self-heal")),
        )
        expect(nudge).toBeUndefined()
        expect(compactionRun).toHaveBeenCalledWith(
          expect.objectContaining({ sessionID: session.id, observed: "empty-response" }),
        )
      },
    })
  }, 30_000)
})
