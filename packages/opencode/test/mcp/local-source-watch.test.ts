import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { MCP } from "../../src/mcp/index"

// Covers MCP.resolveLocalSourceWatch — the entry-source resolver behind
// stale-local-stdio detection. A local MCP child spawned from source that is
// later edited keeps serving its old tool list (it never emits
// ToolListChanged). We baseline the entry file's mtime at spawn so tools() can
// notice the edit and reconnect.
// See issues/20260611_specbase_event_record_tool_not_surfaced_issue.md.

// XDG-private scratch dir (security rule: never use shared /tmp as workdir).
const base = process.env.XDG_RUNTIME_DIR ?? process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
let dir: string

beforeAll(async () => {
  dir = path.join(base, "opencode-test", "local-source-watch")
  await fs.mkdir(dir, { recursive: true })
  await fs.chmod(dir, 0o700)
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("MCP.resolveLocalSourceWatch", () => {
  test("resolves the script arg, not the interpreter, for `bun <script>`", async () => {
    const script = path.join(dir, "server.ts")
    await fs.writeFile(script, "// server\n")
    const watch = await MCP.resolveLocalSourceWatch(["bun", "server.ts"], dir)
    expect(watch?.entryPath).toBe(script)
    expect(typeof watch?.mtimeMs).toBe("number")
  })

  test("skips an interpreter even when a same-named file exists in cwd", async () => {
    // A file literally named `bun` next to the real script must not shadow it.
    await fs.writeFile(path.join(dir, "bun"), "decoy\n")
    const script = path.join(dir, "server.ts")
    const watch = await MCP.resolveLocalSourceWatch(["bun", "server.ts"], dir)
    expect(watch?.entryPath).toBe(script)
  })

  test("resolves an absolute compiled-binary command", async () => {
    const bin = path.join(dir, "compiled-server")
    await fs.writeFile(bin, "#!/bin/sh\n")
    const watch = await MCP.resolveLocalSourceWatch([bin], dir)
    expect(watch?.entryPath).toBe(bin)
  })

  test("returns undefined when no token resolves to a local file (e.g. npx package)", async () => {
    const watch = await MCP.resolveLocalSourceWatch(["npx", "-y", "@scope/not-a-local-file"], dir)
    expect(watch).toBeUndefined()
  })

  test("captured mtime reflects a later edit (drives reconnect decision)", async () => {
    const script = path.join(dir, "mutating.ts")
    await fs.writeFile(script, "v1\n")
    const before = await MCP.resolveLocalSourceWatch(["bun", "mutating.ts"], dir)
    // Bump mtime into the future so the comparison is robust on coarse clocks.
    const future = new Date(Date.now() + 5_000)
    await fs.utimes(script, future, future)
    const after = await MCP.resolveLocalSourceWatch(["bun", "mutating.ts"], dir)
    expect(after?.mtimeMs).not.toBe(before?.mtimeMs)
  })
})
