import { ANTIGRAVITY_ENDPOINT_PROD } from "./packages/opencode/src/plugin/antigravity/constants"

async function test(modelInBody: string) {
  const url = `${ANTIGRAVITY_ENDPOINT_PROD}/v1internal:streamGenerateContent?alt=sse`
  console.log(`\nTesting: ${url} with model in body: ${modelInBody}`)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        project: "useful-fuze-12345",
        model: modelInBody,
        requestType: "agent",
        request: { contents: [{ parts: [{ text: "hi" }] }] },
      }),
    })
    console.log(`Status: ${res.status} ${res.statusText}`)
    const text = await res.text()
    console.log(`Body excerpt: ${text.slice(0, 200)}`)
  } catch (err) {
    console.log(`Error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

await test("gemini-3-pro-high")
await test("gemini-3-pro")
await test("claude-3-7-sonnet")
