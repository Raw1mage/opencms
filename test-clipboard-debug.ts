import { Clipboard } from "./src/cli/cmd/tui/util/clipboard.ts"
import { debugInit } from "./src/util/debug.ts"

// Set env var
process.env["OPENCODE_CLIPBOARD_IMAGE_PATH"] = "/tmp/test.png"
// Write a valid PNG
await Bun.write(
  "/tmp/test.png",
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
)

debugInit()
console.log("Reading clipboard...")
const content = await Clipboard.read()
console.log("Content mime:", content?.mime)
console.log("Content data length:", content?.data?.length)
