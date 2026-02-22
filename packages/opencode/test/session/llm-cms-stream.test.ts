import { beforeAll, beforeEach, afterAll, test, expect } from "bun:test"
import path from "path"
import { LLM } from "../../src/session/llm"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import type { Agent } from "../../src/agent/agent"
import type { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{ path: string; response: Response; resolve: (value: Capture) => void }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: { content: text } }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) return new Response("unexpected request", { status: 500 })

      const url = new URL(req.url)
      let body: Record<string, unknown> = {}
      try {
        body = (await req.clone().json()) as Record<string, unknown>
      } catch {
        body = {}
      }
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) return new Response("not found", { status: 404 })
      return next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  state.server?.stop()
})

test("cms stream payload uses openai-compatible contract", async () => {
  const server = state.server
  if (!server) throw new Error("server not initialized")

  const providerId = "cms-openai"
  const modelID = "cms-model"

  const request = waitRequest(
    "/chat/completions",
    new Response(createChatStream("Hello"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  )

  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          disabled_providers: [],
          enabled_providers: [providerId],
          provider: {
            [providerId]: {
              name: "CMS OpenAI Compatible",
              npm: "@ai-sdk/openai-compatible",
              api: `${server.url.origin}/v1`,
              env: [],
              models: {
                [modelID]: {
                  name: "CMS Model",
                  tool_call: true,
                  attachment: false,
                  reasoning: true,
                  temperature: true,
                  release_date: "2026-01-01",
                  limit: { context: 64000, output: 4000 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: `${server.url.origin}/v1`,
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Provider.reset()
      const model = await Provider.getModel(providerId, modelID)
      const session = await Session.create({})
      const agent = {
        name: "test",
        mode: "primary",
        options: {},
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        temperature: 0.4,
      } satisfies Agent.Info
      const user = {
        id: "user-cms-stream",
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerId, modelID: model.id },
      } satisfies MessageV2.User

      const stream = await LLM.stream({
        user,
        sessionID: session.id,
        model,
        agent,
        system: ["You are a helpful assistant."],
        abort: new AbortController().signal,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
      })
      for await (const _ of stream.fullStream) {
      }

      const capture = await request
      expect(capture.url.pathname.endsWith("/chat/completions")).toBe(true)
      expect(capture.headers.get("Authorization")).toBe("Bearer test-key")
      expect(capture.body.model).toBe(model.api.id)
      expect(capture.body.stream).toBe(true)
      expect(typeof capture.body.max_tokens === "number" || typeof capture.body.max_output_tokens === "number").toBe(
        true,
      )
    },
  })
}, 15000)

test("cms stream payload supports google contract on current cms transport", async () => {
  const server = state.server
  if (!server) throw new Error("server not initialized")

  const providerId = "google"
  const modelID = "gemini-2.5-flash"

  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          disabled_providers: [],
          provider: {
            [providerId]: {
              options: {
                apiKey: "test-google-key",
                baseURL: `${server.url.origin}/v1beta`,
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = await Provider.getModel(providerId, modelID)
      const session = await Session.create({})
      const agent = {
        name: "test",
        mode: "primary",
        options: {},
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        temperature: 0.3,
        topP: 0.8,
      } satisfies Agent.Info
      const user = {
        id: "user-cms-google-stream",
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerId, modelID: model.id },
      } satisfies MessageV2.User

      const abortController = new AbortController()
      const stream = await LLM.stream({
        user,
        sessionID: session.id,
        model,
        agent,
        system: ["You are a helpful assistant."],
        abort: abortController.signal,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
      })

      const iterator = stream.fullStream[Symbol.asyncIterator]()
      const firstChunk = iterator
        .next()
        .then(() => ({ type: "chunk" as const }))
        .catch((error) => ({ type: "error" as const, error }))
      const first = await firstChunk
      if (first.type === "error") throw first.error
      expect(first.type).toBe("chunk")

      abortController.abort()
      await iterator.return?.()
      await firstChunk
    },
  })
}, 20000)

test("cms gemini model can be resolved from google provider baseline", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          disabled_providers: [],
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = await Provider.getModel("google", "gemini-2.5-flash")
      expect(model.providerId).toBe("google")
      expect(model.id).toBe("gemini-2.5-flash")
    },
  })
})
