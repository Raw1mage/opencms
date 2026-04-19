import { describe, expect, test, afterEach } from "bun:test"
import path from "path"
import { InstructionPrompt } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { RebindEpoch } from "../../src/session/rebind-epoch"
import { tmpdir } from "../fixture/fixture"

describe("InstructionPrompt.systemPaths", () => {
  test("finds AGENTS.md at project root", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Project Instructions")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const paths = await InstructionPrompt.systemPaths()
        expect(paths.has(path.resolve(tmp.path, "AGENTS.md"))).toBe(true)
      },
    })
  })

  test("ignores AGENTS.md in subdirectories", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "packages", "app", "AGENTS.md"), "# Subdir Instructions")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const paths = await InstructionPrompt.systemPaths()
        expect(paths.has(path.resolve(tmp.path, "packages", "app", "AGENTS.md"))).toBe(false)
      },
    })
  })

  test("ignores legacy .opencode/AGENTS.md path", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".opencode", "AGENTS.md"), "# Legacy Project Instructions")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const paths = await InstructionPrompt.systemPaths()
        expect(paths.has(path.resolve(tmp.path, ".opencode", "AGENTS.md"))).toBe(false)
      },
    })
  })

  test("ignores CLAUDE.md and CONTEXT.md at project level", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "CLAUDE.md"), "# Claude Instructions")
        await Bun.write(path.join(dir, "CONTEXT.md"), "# Context")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const paths = await InstructionPrompt.systemPaths()
        // Should not contain CLAUDE.md or CONTEXT.md (only global AGENTS.md may exist)
        expect(paths.has(path.resolve(tmp.path, "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.resolve(tmp.path, "CONTEXT.md"))).toBe(false)
      },
    })
  })
})

describe("InstructionPrompt.system — epoch-based cache (session-rebind-capability-refresh)", () => {
  afterEach(() => {
    InstructionPrompt.flushSystemCache()
    RebindEpoch.reset()
  })

  test("same session + same epoch returns cached value (no re-read on subsequent calls)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Version A")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = "ses_cache_hit"
        await RebindEpoch.bumpEpoch({ sessionID, trigger: "daemon_start" })
        const first = await InstructionPrompt.system(sessionID)
        // Simulate external file edit after first read
        await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Version B")
        const second = await InstructionPrompt.system(sessionID)
        // Same epoch → cached; must not reflect the new file content
        expect(second).toEqual(first)
        expect(second.join("\n")).toContain("Version A")
        expect(second.join("\n")).not.toContain("Version B")
      },
    })
  })

  test("bumping rebind epoch invalidates cache and re-reads from disk", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Version A")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = "ses_cache_miss_on_bump"
        await RebindEpoch.bumpEpoch({ sessionID, trigger: "daemon_start" })
        const first = await InstructionPrompt.system(sessionID)
        expect(first.join("\n")).toContain("Version A")

        // External edit + rebind bump → next read must reflect the new content
        await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Version B")
        await RebindEpoch.bumpEpoch({ sessionID, trigger: "slash_reload" })

        const second = await InstructionPrompt.system(sessionID)
        expect(second.join("\n")).toContain("Version B")
        expect(second.join("\n")).not.toContain("Version A")
      },
    })
  })

  test("no-sessionID (legacy caller) falls back to epoch=0 cache namespace", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Legacy V1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await InstructionPrompt.system()
        await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Legacy V2")
        const second = await InstructionPrompt.system()
        // Cache namespace stable (epoch=0) — second call returns cached V1
        expect(second).toEqual(first)
        expect(second.join("\n")).toContain("Legacy V1")
      },
    })
  })

  test("different sessions with different epochs see independent cache entries", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Shared")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await RebindEpoch.bumpEpoch({ sessionID: "ses_a", trigger: "daemon_start" })
        await RebindEpoch.bumpEpoch({ sessionID: "ses_b", trigger: "daemon_start" })
        const a = await InstructionPrompt.system("ses_a")
        const b = await InstructionPrompt.system("ses_b")
        // Content identical (same file)
        expect(a).toEqual(b)
        // But bumping only ses_a must not affect ses_b's cache
        await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Shared v2")
        await RebindEpoch.bumpEpoch({ sessionID: "ses_a", trigger: "slash_reload" })
        const a2 = await InstructionPrompt.system("ses_a")
        const b2 = await InstructionPrompt.system("ses_b")
        expect(a2.join("\n")).toContain("Shared v2")
        // ses_b still at old epoch → still cached with V1
        expect(b2.join("\n")).toContain("Shared")
        expect(b2.join("\n")).not.toContain("v2")
      },
    })
  })

  test("flushSystemCache drops all entries (primarily for tests)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# V1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = "ses_flush"
        await RebindEpoch.bumpEpoch({ sessionID, trigger: "daemon_start" })
        await InstructionPrompt.system(sessionID)
        await Bun.write(path.join(tmp.path, "AGENTS.md"), "# V2")
        // Without flushing, cache hit returns V1
        const cached = await InstructionPrompt.system(sessionID)
        expect(cached.join("\n")).toContain("V1")
        // Flush, then same epoch call reads fresh
        InstructionPrompt.flushSystemCache()
        const fresh = await InstructionPrompt.system(sessionID)
        expect(fresh.join("\n")).toContain("V2")
      },
    })
  })
})
