import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import type { MessageV2 } from "../../src/session/message-v2"

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const originalModelsPath = process.env.OPENCODE_MODELS_PATH
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "../tool/fixtures/models-api.json")

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
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })
      if (!url.pathname.endsWith(next.path)) return new Response("not found", { status: 404 })
      return next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
  mock.restore()
  Provider.reset()
})

afterAll(() => {
  state.server?.stop()
  if (originalModelsPath === undefined) delete process.env.OPENCODE_MODELS_PATH
  else process.env.OPENCODE_MODELS_PATH = originalModelsPath
})

describe("session.llm rate limit routing", () => {
  test("passes providerId and accountId to RateLimitJudge in the correct order", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const judgeCalls: Array<{ providerId: string; accountId: string; modelId: string }> = []
    mock.module("@/account/rate-limit-judge", () => ({
      RateLimitJudge: {
        async judge(providerId: string, accountId: string, modelId: string) {
          judgeCalls.push({ providerId, accountId, modelId })
          return { reason: "UNKNOWN", backoffMs: 1000, source: "error-response", dailyFailures: 1 }
        },
        async recordAuthFailure(providerId: string, accountId: string, modelId: string) {
          judgeCalls.push({ providerId, accountId, modelId })
        },
      },
      isRateLimitError: () => true,
      isAuthError: () => false,
      formatRateLimitReason: () => "Rate limited",
    }))

    const { LLM } = await import("../../src/session/llm")

    const request = waitRequest(
      "/chat/completions",
      new Response(JSON.stringify({ error: { message: "rate limit" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            disabled_providers: [],
            enabled_providers: ["openai"],
            provider: {
              openai: {
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
        const resolved = await Provider.getModel("openai", "gpt-5.4")
        const session = await Session.create({})
        const sessionID = session.id
        const accountId = "openai-subscription-pincyluo-gmail-com"
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: "user-rate-limit",
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerId: "openai", modelID: resolved.id, accountId },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          accountId,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        try {
          for await (const _ of stream.fullStream) {
          }
        } catch {}
      },
    })

    await request

    expect(judgeCalls).toHaveLength(1)
    expect(judgeCalls[0]).toEqual({
      providerId: "openai",
      accountId: "openai-subscription-pincyluo-gmail-com",
      modelId: "gpt-5.4",
    })
  })

  // Committed contract (df4bf81aa "fix(session): stop falling back to global
  // activeAccount for in-flight requests"): when a request has no session-pinned
  // account, the runtime MUST NOT silently backfill from the global active
  // account (RCA 2026-05-18: the getActive fallback caused an empty-response
  // compaction loop). input.accountId stays undefined and no account header is
  // emitted. This test guards that the fallback is NOT reintroduced.
  test("does not backfill global active account onto stream input when session account is missing", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    mock.module("@/account", () => ({
      Account: {
        FAMILIES: ["openai"],
        parseProvider(accountId: string) {
          return accountId.startsWith("openai-") ? "openai" : undefined
        },
        parseFamily(accountId: string) {
          return accountId.startsWith("openai-") ? "openai" : undefined
        },
        async listAll() {
          return {}
        },
        async resolveFamily(providerId: string) {
          return providerId === "openai" || providerId.startsWith("openai-") ? "openai" : undefined
        },
        async resolveFamilyOrSelf(providerId: string) {
          return providerId === "openai" || providerId.startsWith("openai-") ? "openai" : providerId
        },
        async knownFamilies() {
          return ["openai"]
        },
        resolveFamilyFromKnown(providerId: string, known: readonly string[]) {
          if (!providerId) return undefined
          const set = new Set(known.filter(Boolean))
          if (set.has(providerId)) return providerId
          const m = providerId.match(/^(.+)-(api|subscription)-/)
          if (m?.[1] && set.has(m[1])) return m[1]
          return undefined
        },
        // getActive intentionally returns a value to prove the runtime does NOT
        // consult it for in-flight request identity (the no-fallback contract).
        async getActive(family: string) {
          return family === "openai" ? "openai-subscription-miatlab-api-gmail-com" : undefined
        },
        getDisplayName(id: string) {
          return id
        },
      },
    }))
    mock.module("@/auth", () => ({
      Auth: {
        async all() {
          return {}
        },
        async get() {
          return undefined
        },
      },
    }))

    const { LLM } = await import("../../src/session/llm")

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
            enabled_providers: ["openai"],
            provider: {
              openai: {
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
        const resolved = await Provider.getModel("openai", "gpt-5.4")
        const session = await Session.create({})
        const sessionID = session.id
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: "user-active-fallback",
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerId: "openai", modelID: resolved.id },
        } satisfies MessageV2.User

        const input: Parameters<typeof LLM.stream>[0] = {
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user" as const, content: "Hello" }],
          tools: {},
        }

        const stream = await LLM.stream(input)
        // No session-pinned account → runtime leaves accountId unresolved; it
        // does NOT consult the global active account (no-fallback contract).
        expect(input.accountId).toBeUndefined()

        for await (const _ of stream.fullStream) {
        }
      },
    })

    const capture = await request
    // With no resolved account the request carries no account header.
    expect(capture.headers.get("x-opencode-account-id")).toBeNull()
  })
})
