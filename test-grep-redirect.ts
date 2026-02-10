import { GrepTool } from "./packages/opencode/src/tool/grep"

const mockCtx: any = {
  ask: async () => {},
  metadata: () => {},
  abort: new AbortController().signal,
  extra: { agent: { name: "test" } },
  sessionID: "ses_test_session_id",
}

async function test() {
  console.log("Testing GrepTool with large output...")
  const instance = await GrepTool.init()

  // Create a pattern that matches many things
  const result = await instance.execute(
    {
      pattern: "import",
      path: ".",
    },
    mockCtx,
  )

  console.log("Title:", result.title)
  console.log("Metadata:", JSON.stringify(result.metadata, null, 2))
  console.log("Output Preview (first 100 chars):")
  console.log(result.output.substring(0, 500))

  if (result.output.includes("Full output saved to:")) {
    console.log("\nSUCCESS: Output was correctly redirected to file and hint was returned.")
  } else {
    console.log("\nFAILURE: Output was not redirected or hint was missing.")
  }
}

test().catch(console.error)
