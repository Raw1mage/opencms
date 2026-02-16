import { describe, expect, test } from "bun:test"
import path from "path"
import { InstructionPrompt } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("InstructionPrompt.systemPaths", () => {
  test("finds .opencode/AGENTS.md at project root", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".opencode", "AGENTS.md"), "# Project Instructions")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const paths = await InstructionPrompt.systemPaths()
        expect(paths.has(path.resolve(tmp.path, ".opencode", "AGENTS.md"))).toBe(true)
      },
    })
  })

  test("ignores AGENTS.md at project root (not in .opencode/)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Root Instructions")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const paths = await InstructionPrompt.systemPaths()
        expect(paths.has(path.resolve(tmp.path, "AGENTS.md"))).toBe(false)
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

  test("ignores CLAUDE.md and CONTEXT.md at project level", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".opencode", "CLAUDE.md"), "# Claude Instructions")
        await Bun.write(path.join(dir, "CONTEXT.md"), "# Context")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const paths = await InstructionPrompt.systemPaths()
        // Should not contain CLAUDE.md or CONTEXT.md (only global AGENTS.md may exist)
        expect(paths.has(path.resolve(tmp.path, ".opencode", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.resolve(tmp.path, "CONTEXT.md"))).toBe(false)
      },
    })
  })
})
