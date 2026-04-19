import { test, expect, afterEach } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import {
  resolveMandatoryList,
  preloadMandatorySkills,
  KEEP_RULES,
} from "../../src/session/mandatory-skills"
import { SkillLayerRegistry } from "../../src/session/skill-layer-registry"

async function writeAgentsMd(dir: string, skills: string[]) {
  const body = [
    "# Project AGENTS.md (test fixture)",
    "",
    "<!-- opencode:mandatory-skills -->",
    ...skills.map((s) => `- ${s}`),
    "<!-- /opencode:mandatory-skills -->",
  ].join("\n")
  await fs.writeFile(path.join(dir, "AGENTS.md"), body, "utf-8")
}

async function writeSkill(dir: string, name: string, content: string) {
  const skillDir = path.join(dir, ".claude", "skills", name)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: Test skill ${name}`,
      "---",
      "",
      content,
    ].join("\n"),
    "utf-8",
  )
}

afterEach(() => {
  SkillLayerRegistry.reset()
})

test("TV10: resolveMandatoryList reads project AGENTS.md sentinel for main agent", async () => {
  await using tmp = await tmpdir()
  await writeAgentsMd(tmp.path, ["test-skill-alpha", "test-skill-beta"])
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await resolveMandatoryList({
        sessionID: "ses_integ_main",
        agent: { name: "main" },
        isSubagent: false,
      })
      expect(result.list).toEqual(["test-skill-alpha", "test-skill-beta"])
      expect(result.bySkill["test-skill-alpha"]).toEqual(["agents_md_project"])
      expect(result.bySkill["test-skill-beta"]).toEqual(["agents_md_project"])
    },
  })
})

test("TV10: preload pins existing skill from project .claude/skills/", async () => {
  await using tmp = await tmpdir()
  await writeAgentsMd(tmp.path, ["demo-skill"])
  await writeSkill(tmp.path, "demo-skill", "This is demo skill full content.")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = "ses_integ_preload"
      const resolved = await resolveMandatoryList({
        sessionID,
        agent: { name: "main" },
        isSubagent: false,
      })
      const outcomes = await preloadMandatorySkills({
        sessionID,
        list: resolved.list,
        bySkill: resolved.bySkill,
      })
      expect(outcomes.length).toBe(1)
      expect(outcomes[0].status).toBe("preloaded")
      expect(outcomes[0].skill).toBe("demo-skill")

      const entry = SkillLayerRegistry.peek(sessionID, "demo-skill")
      expect(entry?.pinned).toBe(true)
      expect(entry?.runtimeState).toBe("sticky")
      expect(entry?.keepRules).toContain(KEEP_RULES.AGENTS_MD)
      expect(entry?.content).toContain("This is demo skill full content.")
    },
  })
})

test("TV11: second preload with same list is idempotent (already_pinned, no re-record)", async () => {
  await using tmp = await tmpdir()
  await writeAgentsMd(tmp.path, ["idempotent-skill"])
  await writeSkill(tmp.path, "idempotent-skill", "Idempotent content body.")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = "ses_integ_idemp"
      const resolved = await resolveMandatoryList({
        sessionID,
        agent: { name: "main" },
        isSubagent: false,
      })
      const first = await preloadMandatorySkills({
        sessionID,
        list: resolved.list,
        bySkill: resolved.bySkill,
      })
      expect(first[0].status).toBe("preloaded")

      const loadedAtFirst = SkillLayerRegistry.peek(sessionID, "idempotent-skill")?.loadedAt
      expect(loadedAtFirst).toBeDefined()

      // Small wait to ensure Date.now() would advance if recordLoaded ran again
      await new Promise((r) => setTimeout(r, 15))

      const second = await preloadMandatorySkills({
        sessionID,
        list: resolved.list,
        bySkill: resolved.bySkill,
      })
      expect(second[0].status).toBe("already_pinned")

      const loadedAtSecond = SkillLayerRegistry.peek(sessionID, "idempotent-skill")?.loadedAt
      expect(loadedAtSecond).toBe(loadedAtFirst)
    },
  })
})

test("TV9: missing skill file — loud warn + continue, no pin, no crash", async () => {
  await using tmp = await tmpdir()
  await writeAgentsMd(tmp.path, ["present-skill", "absent-skill"])
  await writeSkill(tmp.path, "present-skill", "Real skill content.")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = "ses_integ_missing"
      const resolved = await resolveMandatoryList({
        sessionID,
        agent: { name: "main" },
        isSubagent: false,
      })
      expect(resolved.list).toEqual(["present-skill", "absent-skill"])

      const outcomes = await preloadMandatorySkills({
        sessionID,
        list: resolved.list,
        bySkill: resolved.bySkill,
      })
      expect(outcomes.length).toBe(2)
      const byStatus = Object.fromEntries(outcomes.map((o) => [o.skill, o.status]))
      expect(byStatus["present-skill"]).toBe("preloaded")
      expect(byStatus["absent-skill"]).toBe("missing")

      expect(SkillLayerRegistry.peek(sessionID, "present-skill")?.pinned).toBe(true)
      expect(SkillLayerRegistry.peek(sessionID, "absent-skill")).toBeUndefined()
    },
  })
})

test("main agent ignores coding.txt sentinel (AGENTS.md is sole source)", async () => {
  await using tmp = await tmpdir()
  await writeAgentsMd(tmp.path, ["agents-skill"])
  // Simulate a coding.txt with its own sentinel — main agent must NOT see it
  const codingTxtPath = path.join(tmp.path, "packages/opencode/src/agent/prompt")
  await fs.mkdir(codingTxtPath, { recursive: true })
  await fs.writeFile(
    path.join(codingTxtPath, "coding.txt"),
    "<!-- opencode:mandatory-skills -->\n- coding-only-skill\n<!-- /opencode:mandatory-skills -->",
    "utf-8",
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const resolved = await resolveMandatoryList({
        sessionID: "ses_integ_mainignores",
        agent: { name: "main" },
        isSubagent: false,
      })
      expect(resolved.list).toEqual(["agents-skill"])
      expect(resolved.list).not.toContain("coding-only-skill")
    },
  })
})

test("coding subagent reads coding.txt sentinel (AGENTS.md ignored)", async () => {
  await using tmp = await tmpdir()
  await writeAgentsMd(tmp.path, ["agents-skill"])
  const codingTxtPath = path.join(tmp.path, "packages/opencode/src/agent/prompt")
  await fs.mkdir(codingTxtPath, { recursive: true })
  await fs.writeFile(
    path.join(codingTxtPath, "coding.txt"),
    "<!-- opencode:mandatory-skills -->\n- coding-only-skill\n<!-- /opencode:mandatory-skills -->",
    "utf-8",
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const resolved = await resolveMandatoryList({
        sessionID: "ses_integ_coding",
        agent: { name: "coding" },
        isSubagent: true,
      })
      expect(resolved.list).toEqual(["coding-only-skill"])
      expect(resolved.list).not.toContain("agents-skill")
      expect(resolved.bySkill["coding-only-skill"]).toEqual(["coding_txt"])
    },
  })
})
