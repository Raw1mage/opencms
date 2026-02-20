import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { APICallError } from "ai"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionRetry } from "../../src/session/retry"
import { SessionPrompt } from "../../src/session/prompt"
import { prepareUserMessageContext } from "../../src/session/user-message-context"
import { LLM } from "../../src/session/llm"
import { tmpdir } from "../fixture/fixture"

describe("session.structured-output", () => {
  afterEach(() => {
    mock.restore()
  })

  function structuredStream(schemaResult: Record<string, unknown>) {
    return async function* (input: Parameters<typeof LLM.stream>[0]) {
      yield { type: "start" }
      yield { type: "start-step" }
      yield { type: "tool-input-start", id: "call_structured", toolName: "StructuredOutput" }

      const toolInput = schemaResult
      const structuredTool = input.tools.StructuredOutput
      if (!structuredTool?.execute) throw new Error("StructuredOutput tool missing")
      const executed = await structuredTool.execute(toolInput, {} as never)

      yield {
        type: "tool-call",
        toolCallId: "call_structured",
        toolName: "StructuredOutput",
        input: toolInput,
      }
      yield {
        type: "tool-result",
        toolCallId: "call_structured",
        input: toolInput,
        output: {
          output: (executed as { output?: string })?.output ?? "Structured output captured successfully.",
          title: (executed as { title?: string })?.title ?? "Structured Output",
          metadata: (executed as { metadata?: Record<string, unknown> })?.metadata ?? { valid: true },
        },
      }
      yield {
        type: "finish-step",
        finishReason: "stop",
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        providerMetadata: {},
      }
      yield { type: "finish" }
    }
  }

  function plainTextStream(text: string) {
    return async function* () {
      yield { type: "start" }
      yield { type: "start-step" }
      yield { type: "text-start" }
      yield { type: "text-delta", text }
      yield { type: "text-end" }
      yield {
        type: "finish-step",
        finishReason: "stop",
        usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
        providerMetadata: {},
      }
      yield { type: "finish" }
    }
  }

  test("persists json_schema format on user message", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await prepareUserMessageContext({
          sessionID: "ses_test_structured",
          model: { providerId: "opencode", modelID: "kimi-k2.5-free" },
          parts: [{ type: "text", text: "return structured output" }],
          format: {
            type: "json_schema",
            retryCount: 2,
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
            },
          },
        })
        expect(info.info.format?.type).toBe("json_schema")
        expect((info.info.format as { retryCount?: number }).retryCount).toBe(2)
      },
    })
  }, 15000)

  test("createStructuredOutputTool captures output", async () => {
    let captured: unknown
    const t = SessionPrompt.createStructuredOutputTool({
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
      },
      onSuccess(output) {
        captured = output
      },
    })

    const result = await t.execute?.({ ok: true }, {} as never)
    expect(captured).toEqual({ ok: true })
    expect(result?.output).toBe("Structured output captured successfully.")
  })

  test("captures structured output in prompt flow", async () => {
    const streamSpy = spyOn(LLM, "stream").mockImplementation(async (input) => {
      return {
        fullStream: structuredStream({ answer: "ok", confidence: 0.9 })(input),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "Return structured output" }],
          format: {
            type: "json_schema",
            retryCount: 2,
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["answer"],
            },
          },
        })

        if (msg.info.role !== "assistant") throw new Error("expected assistant")
        expect(msg.info.structured).toEqual({ answer: "ok", confidence: 0.9 })
        expect(msg.info.error).toBeUndefined()
      },
    })

    expect(streamSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
    const toolChoiceCall = streamSpy.mock.calls.find((call) => call[0]?.toolChoice === "required")
    expect(toolChoiceCall).toBeDefined()
  })

  test("writes StructuredOutputError when model returns plain text", async () => {
    spyOn(LLM, "stream").mockImplementation(async () => {
      return {
        fullStream: plainTextStream("I forgot structured output")(),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "must be structured" }],
          format: {
            type: "json_schema",
            retryCount: 1,
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
            },
          },
        })

        if (msg.info.role !== "assistant") throw new Error("expected assistant")
        expect(msg.info.structured).toBeUndefined()
        expect(msg.info.error?.name).toBe("StructuredOutputError")
      },
    })
  })

  test("retries once and still captures structured output", async () => {
    let attempt = 0
    const streamSpy = spyOn(LLM, "stream").mockImplementation(async (input) => {
      attempt++
      if (attempt === 1) {
        throw new APICallError({
          message: "transient failure",
          url: "https://test.invalid",
          requestBodyValues: {},
          statusCode: 418,
          responseHeaders: {},
          responseBody: "{}",
          isRetryable: true,
        })
      }
      return {
        fullStream: structuredStream({ answer: "recovered" })(input),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })
    spyOn(SessionRetry, "sleep").mockImplementation(async () => {})

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "retry then structured" }],
          format: {
            type: "json_schema",
            retryCount: 2,
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
            },
          },
        })

        if (msg.info.role !== "assistant") throw new Error("expected assistant")
        expect(msg.info.structured).toEqual({ answer: "recovered" })
      },
    })

    expect(streamSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  test("supports async prompt execution with json_schema format", async () => {
    spyOn(LLM, "stream").mockImplementation(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        fullStream: structuredStream({ answer: "async-ok" })(input),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const run = SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "async structured" }],
          format: {
            type: "json_schema",
            retryCount: 1,
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        })
        expect(run).toBeInstanceOf(Promise)

        const deadline = Date.now() + 3000
        let assistantStructured: unknown
        while (Date.now() < deadline) {
          const messages = await Session.messages({ sessionID: session.id })
          const assistant = messages.find((message) => message.info.role === "assistant")
          if (assistant?.info.role === "assistant" && assistant.info.structured) {
            assistantStructured = assistant.info.structured
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }

        expect(assistantStructured).toEqual({ answer: "async-ok" })
      },
    })
  }, 10_000)

  test("keeps json_schema flow after auto compaction", async () => {
    let overflowChecks = 0
    spyOn(SessionCompaction, "isOverflow").mockImplementation(async () => {
      overflowChecks++
      return overflowChecks === 1
    })

    let normalCalls = 0
    spyOn(LLM, "stream").mockImplementation(async (input) => {
      if (input.agent.name === "compaction") {
        return {
          fullStream: plainTextStream("compaction summary")(),
        } as unknown as Awaited<ReturnType<typeof LLM.stream>>
      }

      normalCalls++
      if (normalCalls === 1) {
        return {
          fullStream: plainTextStream("intermediate response before compaction")(),
        } as unknown as Awaited<ReturnType<typeof LLM.stream>>
      }

      return {
        fullStream: structuredStream({ answer: "after-compact" })(input),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "answer in schema even after compaction" }],
          format: {
            type: "json_schema",
            retryCount: 1,
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        })

        if (msg.info.role !== "assistant") throw new Error("expected assistant")
        expect(msg.info.structured).toEqual({ answer: "after-compact" })
      },
    })
  })

  test("retains previous structured output across follow-up turn", async () => {
    let call = 0
    spyOn(LLM, "stream").mockImplementation(async (input) => {
      call++
      return {
        fullStream: structuredStream({ answer: `turn-${call}` })(input),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
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
          parts: [{ type: "text", text: "first response" }],
          format: {
            type: "json_schema",
            retryCount: 1,
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        })

        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "second response" }],
          format: {
            type: "json_schema",
            retryCount: 1,
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        })

        const messages = await Session.messages({ sessionID: session.id })
        const assistants = messages.filter((m) => m.info.role === "assistant")
        expect(assistants.length).toBeGreaterThanOrEqual(2)
        const structuredValues = assistants
          .map((m) => (m.info.role === "assistant" ? m.info.structured : undefined))
          .filter((v): v is { answer: string } => typeof v === "object" && v !== null && "answer" in v)
          .map((v) => v.answer)

        expect(structuredValues).toContain("turn-1")
        expect(new Set(structuredValues).size).toBeGreaterThanOrEqual(2)
      },
    })
  })
})
