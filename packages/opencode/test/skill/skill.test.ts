import { test, expect, afterEach } from "bun:test"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

// New architecture: skills are read from a SINGLE authoritative source —
// Global.Path.data/skills (~/.local/share/opencode/skills). Sources that used
// to be scanned (~/.claude, ~/.agents, ~/.config/opencode/skills, project
// .opencode/skills, config.skills.paths/urls) are deliberately NOT scanned;
// they pulled in same-name copies from other agents and caused shadowing.

const skillRoot = path.join(Global.Path.data, "skills")

async function writeCentralSkill(name: string, description: string) {
  const dir = path.join(skillRoot, name)
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

# ${name}

Instructions here.
`,
  )
}

async function cleanCentral() {
  await fs.rm(skillRoot, { recursive: true, force: true }).catch(() => {})
  Skill.reset()
}

afterEach(cleanCentral)

test("discovers a skill from the central data/skills directory", async () => {
  await cleanCentral()
  await writeCentralSkill("test-skill", "A test skill for verification.")
  Skill.reset()

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      const testSkill = skills.find((s) => s.name === "test-skill")
      expect(testSkill).toBeDefined()
      expect(testSkill!.description).toBe("A test skill for verification.")
      expect(testSkill!.location).toBe(path.join(skillRoot, "test-skill", "SKILL.md"))
    },
  })
})

test("discovers multiple skills from the central directory", async () => {
  await cleanCentral()
  await writeCentralSkill("skill-one", "First test skill.")
  await writeCentralSkill("skill-two", "Second test skill.")
  Skill.reset()

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.find((s) => s.name === "skill-one")).toBeDefined()
      expect(skills.find((s) => s.name === "skill-two")).toBeDefined()
    },
  })
})

test("skips skills with missing frontmatter", async () => {
  await cleanCentral()
  const dir = path.join(skillRoot, "no-frontmatter")
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, "SKILL.md"), `# No Frontmatter\n\nJust content, no YAML.\n`)
  Skill.reset()

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.find((s) => s.name === "no-frontmatter")).toBeUndefined()
    },
  })
})

test("does NOT scan project .opencode/skills (only central source)", async () => {
  await cleanCentral()
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      // A skill placed in the project's .opencode/skills must be IGNORED under
      // the single-source policy.
      const skillDir = path.join(dir, ".opencode", "skills", "project-local-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: project-local-skill
description: Should be ignored — project-local is no longer scanned.
---

# Project Local Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.find((s) => s.name === "project-local-skill")).toBeUndefined()
    },
  })
})

test("does NOT scan ~/.claude/skills (only central source)", async () => {
  await cleanCentral()
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".claude", "skills", "claude-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: claude-skill
description: Should be ignored — .claude is no longer scanned.
---

# Claude Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.find((s) => s.name === "claude-skill")).toBeUndefined()
    },
  })
})

test("returns empty array when the central directory has no skills", async () => {
  await cleanCentral()
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      const local = skills.filter((s) =>
        s.location.startsWith(skillRoot + path.sep),
      )
      expect(local).toEqual([])
    },
  })
})
