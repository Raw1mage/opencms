import { describe, expect, test, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import type { PermissionNext } from "../../src/permission/next"
import type { Tool } from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { Skill } from "../../src/skill"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

// New architecture: skills are read from a SINGLE authoritative source —
// Global.Path.data/skills. Tests must write skills there (not .opencode/skill).
const skillRoot = path.join(Global.Path.data, "skills")

async function writeCentralSkill(name: string, description: string, extra?: (dir: string) => Promise<void>) {
  const dir = path.join(skillRoot, name)
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

# ${name}

Use this skill.
`,
  )
  if (extra) await extra(dir)
}

async function cleanCentral() {
  await fs.rm(skillRoot, { recursive: true, force: true }).catch(() => {})
  Skill.reset()
}

afterEach(cleanCentral)

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

describe("tool.skill", () => {
  test("description lists skill location URL", async () => {
    await cleanCentral()
    await writeCentralSkill("tool-skill", "Skill for tool tests.")
    Skill.reset()

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillTool.init()
        const skillPath = path.join(skillRoot, "tool-skill", "SKILL.md")
        expect(tool.description).toContain(`<location>${pathToFileURL(skillPath).href}</location>`)
      },
    })
  })

  test("execute returns skill content block with files", async () => {
    await cleanCentral()
    await writeCentralSkill("tool-skill", "Skill for tool tests.", async (dir) => {
      await Bun.write(path.join(dir, "scripts", "demo.txt"), "demo")
    })
    Skill.reset()

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const ctx: Tool.Context = {
          ...baseCtx,
          ask: async (req) => {
            requests.push(req)
          },
        }

        const result = await tool.execute({ name: "tool-skill" }, ctx)
        const dir = path.join(skillRoot, "tool-skill")
        const file = path.resolve(dir, "scripts", "demo.txt")

        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("skill")
        expect(requests[0].patterns).toContain("tool-skill")
        expect(requests[0].always).toContain("tool-skill")

        expect(result.metadata.dir).toBe(dir)
        // Skill tool now emits a <skill_loaded> marker; the actual content is
        // injected via session-managed skill layers (dynamic context layers).
        expect(result.output).toContain(`<skill_loaded name="tool-skill">`)
        expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(dir).href}`)
        expect(result.output).toContain(`<file>${file}</file>`)
      },
    })
  })
})
