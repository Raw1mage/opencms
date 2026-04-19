import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { RebindEpoch } from "../../src/session/rebind-epoch"
import {
  CapabilityLayer,
  setCapabilityLayerLoader,
} from "../../src/session/capability-layer"
import { buildProductionCapabilityLoader } from "../../src/session/capability-layer-loader"
import { SkillLayerRegistry } from "../../src/session/skill-layer-registry"
import { InstructionPrompt } from "../../src/session/instruction"

async function writeAgentsMd(dir: string, skills: string[], body = "# Project AGENTS.md") {
  const block = [
    body,
    "",
    "<!-- opencode:mandatory-skills -->",
    ...skills.map((s) => `- ${s}`),
    "<!-- /opencode:mandatory-skills -->",
  ].join("\n")
  await fs.writeFile(path.join(dir, "AGENTS.md"), block, "utf-8")
}

async function writeSkill(dir: string, name: string, content: string) {
  const skillDir = path.join(dir, ".claude", "skills", name)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name} desc`, "---", "", content].join("\n"),
    "utf-8",
  )
}

function onlyFromProject(list: string[]) {
  // Filter out skills that come from the real global ~/.config/opencode/AGENTS.md
  // so test assertions stay isolated even when the dev box ships with a sentinel.
  return list.filter((s) => s !== "plan-builder")
}

afterEach(() => {
  RebindEpoch.reset()
  CapabilityLayer.reset()
  InstructionPrompt.flushSystemCache()
  SkillLayerRegistry.reset()
  setCapabilityLayerLoader(null)
})

describe("CapabilityLayer runtime integration", () => {
  test("same epoch across multiple get() calls → zero additional disk reads", async () => {
    await using tmp = await tmpdir()
    await writeAgentsMd(tmp.path, ["probe-skill"])
    await writeSkill(tmp.path, "probe-skill", "probe content")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const loader = buildProductionCapabilityLoader(async () => ({
          sessionID: "ses_same_epoch",
          epoch: 1,
          agent: { name: "main" },
          isSubagent: false,
        }))
        setCapabilityLayerLoader(loader)

        const sessionID = "ses_same_epoch"
        await RebindEpoch.bumpEpoch({ sessionID, trigger: "daemon_start" })
        const e = RebindEpoch.current(sessionID)

        const first = await CapabilityLayer.get(sessionID, e)
        const pinnedFirst = onlyFromProject(first.layers.skill_content.pinnedSkills)
        expect(pinnedFirst).toContain("probe-skill")

        // Edit AGENTS.md externally — without bumping epoch, cache hit returns
        // stale content; disk must NOT be re-read.
        await writeAgentsMd(tmp.path, ["probe-skill"], "# MUTATED BODY")
        const second = await CapabilityLayer.get(sessionID, e)
        expect(second.epoch).toBe(e)
        expect(second.layers.agents_md.text).toBe(first.layers.agents_md.text)
        expect(second.layers.agents_md.text).not.toContain("MUTATED BODY")
      },
    })
  })

  test("bumpEpoch causes cache miss → re-reads fresh AGENTS.md", async () => {
    await using tmp = await tmpdir()
    await writeAgentsMd(tmp.path, ["probe-skill"], "# Version A")
    await writeSkill(tmp.path, "probe-skill", "probe")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const loader = buildProductionCapabilityLoader(async () => ({
          sessionID: "ses_bump_refresh",
          epoch: RebindEpoch.current("ses_bump_refresh"),
          agent: { name: "main" },
          isSubagent: false,
        }))
        setCapabilityLayerLoader(loader)

        const sessionID = "ses_bump_refresh"
        await RebindEpoch.bumpEpoch({ sessionID, trigger: "daemon_start" })
        const first = await CapabilityLayer.get(sessionID, RebindEpoch.current(sessionID))
        expect(first.layers.agents_md.text).toContain("Version A")

        // Edit file + bump epoch
        await writeAgentsMd(tmp.path, ["probe-skill"], "# Version B")
        await RebindEpoch.bumpEpoch({ sessionID, trigger: "slash_reload" })

        const second = await CapabilityLayer.get(sessionID, RebindEpoch.current(sessionID))
        expect(second.epoch).not.toBe(first.epoch)
        expect(second.layers.agents_md.text).toContain("Version B")
      },
    })
  })

  test("reinject pins skill in SkillLayerRegistry as side effect (DD-15)", async () => {
    await using tmp = await tmpdir()
    await writeAgentsMd(tmp.path, ["demo-skill"])
    await writeSkill(tmp.path, "demo-skill", "demo content")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = "ses_pin_sideeffect"
        const loader = buildProductionCapabilityLoader(async () => ({
          sessionID,
          epoch: RebindEpoch.current(sessionID),
          agent: { name: "main" },
          isSubagent: false,
        }))
        setCapabilityLayerLoader(loader)

        await RebindEpoch.bumpEpoch({ sessionID, trigger: "daemon_start" })
        await CapabilityLayer.get(sessionID, RebindEpoch.current(sessionID))

        const entry = SkillLayerRegistry.peek(sessionID, "demo-skill")
        expect(entry?.pinned).toBe(true)
        expect(entry?.content).toContain("demo content")
      },
    })
  })

  test("previous-epoch cache survives a failed reinject (R3 fallback)", async () => {
    await using tmp = await tmpdir()
    await writeAgentsMd(tmp.path, ["demo-skill"], "# V1")
    await writeSkill(tmp.path, "demo-skill", "v1 content")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = "ses_r3_fallback"
        let failNext = false
        const loader = {
          async load(input: { sessionID: string; epoch: number }) {
            if (failNext) throw new Error("simulated loader failure")
            // Use production loader on the happy path by delegating manually.
            const prod = buildProductionCapabilityLoader(async () => ({
              sessionID: input.sessionID,
              epoch: input.epoch,
              agent: { name: "main" },
              isSubagent: false,
            }))
            return prod.load(input)
          },
        }
        setCapabilityLayerLoader(loader)

        await RebindEpoch.bumpEpoch({ sessionID, trigger: "daemon_start" })
        const first = await CapabilityLayer.get(sessionID, RebindEpoch.current(sessionID))
        expect(first.layers.agents_md.text).toContain("V1")
        const firstEpoch = first.epoch

        // Bump to new epoch + arrange failure for next reinject
        await RebindEpoch.bumpEpoch({ sessionID, trigger: "slash_reload" })
        failNext = true

        // Requesting new epoch returns the previous-epoch entry as fallback
        const fallback = await CapabilityLayer.get(sessionID, RebindEpoch.current(sessionID))
        expect(fallback.epoch).toBe(firstEpoch)
        expect(fallback.layers.agents_md.text).toContain("V1")
      },
    })
  })
})
