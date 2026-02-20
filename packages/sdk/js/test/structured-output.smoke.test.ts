import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "../src/v2/client"

type RecordedRequest = {
  url: string
  method: string
  body: Record<string, unknown>
}

function createRecordingFetch(status = 204) {
  const calls: RecordedRequest[] = []
  const fetchFn = (async (input: RequestInfo | URL) => {
    const req = input as Request
    const bodyText = await req.text()
    calls.push({
      url: req.url,
      method: req.method,
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
    })
    return new Response("", {
      status,
      headers: {
        "content-type": "application/json",
      },
    })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

describe("sdk.v2 structured output smoke", () => {
  const format = {
    type: "json_schema" as const,
    retryCount: 2,
    schema: {
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
    },
  }

  test("prompt sends format=json_schema payload", async () => {
    const { fetchFn, calls } = createRecordingFetch()
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      fetch: fetchFn,
    })

    await client.session.prompt({
      sessionID: "ses_smoke",
      parts: [{ type: "text", text: "return schema" }],
      format,
    })

    expect(calls.length).toBe(1)
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toContain("/session/ses_smoke/message")
    expect(calls[0]?.body.format).toEqual(format)
  })

  test("promptAsync sends format=json_schema payload", async () => {
    const { fetchFn, calls } = createRecordingFetch()
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      fetch: fetchFn,
    })

    await client.session.promptAsync({
      sessionID: "ses_smoke",
      parts: [{ type: "text", text: "return schema async" }],
      format,
    })

    expect(calls.length).toBe(1)
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toContain("/session/ses_smoke/prompt_async")
    expect(calls[0]?.body.format).toEqual(format)
  })
})
