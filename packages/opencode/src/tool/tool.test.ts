import { describe, expect, it } from "bun:test"
import z from "zod"
import { Tool } from "./tool"

function makeCtx(): Tool.Context {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    abort: new AbortController().signal,
    callID: "call_test",
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

describe("Tool.define execute wrapper", () => {
  it("passes z.preprocess-normalized args to execute", async () => {
    let received: unknown
    const tool = Tool.define("t_preprocess", async () => ({
      description: "test",
      parameters: z.preprocess(
        (raw) => {
          if (raw && typeof raw === "object" && "bar" in (raw as any)) {
            return { foo: (raw as any).bar }
          }
          return raw
        },
        z.object({ foo: z.string() }),
      ),
      async execute(args) {
        received = args
        return { title: "ok", output: "ok", metadata: { truncated: false } }
      },
    }))

    const info = await tool.init()
    await info.execute({ bar: "x" } as any, makeCtx())
    expect(received).toEqual({ foo: "x" })
  })

  it("preserves canonical input unchanged (structurally)", async () => {
    let received: unknown
    const tool = Tool.define("t_canonical", async () => ({
      description: "test",
      parameters: z.object({ foo: z.string() }),
      async execute(args) {
        received = args
        return { title: "ok", output: "ok", metadata: { truncated: false } }
      },
    }))

    const info = await tool.init()
    await info.execute({ foo: "x" }, makeCtx())
    expect(received).toEqual({ foo: "x" })
  })

  it("applies z.default to fill in missing optional fields", async () => {
    let received: any
    const tool = Tool.define("t_default", async () => ({
      description: "test",
      parameters: z.object({
        name: z.string(),
        count: z.number().default(10),
      }),
      async execute(args) {
        received = args
        return { title: "ok", output: "ok", metadata: { truncated: false } }
      },
    }))

    const info = await tool.init()
    await info.execute({ name: "hello" } as any, makeCtx())
    expect(received.name).toBe("hello")
    expect(received.count).toBe(10)
  })

  it("does not call execute on ZodError, using formatValidationError if provided", async () => {
    let executeCalled = false
    const tool = Tool.define("t_invalid_with_hint", async () => ({
      description: "test",
      parameters: z.object({ foo: z.string() }),
      formatValidationError: () => "[schema-miss:t_invalid_with_hint] custom hint",
      async execute() {
        executeCalled = true
        return { title: "x", output: "x", metadata: { truncated: false } }
      },
    }))

    const info = await tool.init()
    await expect(info.execute({ baz: 1 } as any, makeCtx())).rejects.toThrow(
      /\[schema-miss:t_invalid_with_hint\]/,
    )
    expect(executeCalled).toBe(false)
  })

  it("does not call execute on ZodError, using generic fallback when no formatter", async () => {
    let executeCalled = false
    const tool = Tool.define("t_invalid_generic", async () => ({
      description: "test",
      parameters: z.object({ foo: z.string() }),
      async execute() {
        executeCalled = true
        return { title: "x", output: "x", metadata: { truncated: false } }
      },
    }))

    const info = await tool.init()
    await expect(info.execute({ baz: 1 } as any, makeCtx())).rejects.toThrow(
      /The t_invalid_generic tool was called with invalid arguments/,
    )
    expect(executeCalled).toBe(false)
  })

  it("runs z.transform (inner) transform and passes transformed value", async () => {
    let received: unknown
    const tool = Tool.define("t_transform", async () => ({
      description: "test",
      parameters: z
        .object({ value: z.string() })
        .transform((v) => ({ value: v.value.trim().toUpperCase() })),
      async execute(args) {
        received = args
        return { title: "ok", output: "ok", metadata: { truncated: false } }
      },
    }))

    const info = await tool.init()
    await info.execute({ value: "  hello  " } as any, makeCtx())
    expect(received).toEqual({ value: "HELLO" })
  })
})
