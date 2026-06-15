import { describe, expect, test } from "bun:test"
import path from "path"

const repoRoot = path.resolve(import.meta.dir, "../../../..")

async function read(relativePath: string) {
  return Bun.file(path.join(repoRoot, relativePath)).text()
}

describe("autorunner bootstrap policy", () => {
  test("project and template AGENTS use workflow-first bootstrap", async () => {
    const projectAgents = await read("AGENTS.md")
    const templateAgents = await read("templates/AGENTS.md")

    // Project AGENTS.md now delegates common bootstrap rules to the Global
    // AGENTS.md and only carries opencms-specific rules (rewritten in b46801f60).
    expect(projectAgents).toContain("通用規則")
    expect(projectAgents).toContain("Mandatory Skills")
    expect(projectAgents).not.toContain("**`software-architect`**: 架構決策核心")
    expect(projectAgents).not.toContain("**`mcp-finder`**: MCP 擴充中樞")
    expect(projectAgents).not.toContain("**`skill-finder`**: Skill 擴充中樞")

    expect(templateAgents).toContain(
      "其餘 skills（如 `model-selector`、`mcp-finder`、`skill-finder`、`software-architect`）均為 **on-demand**",
    )
    expect(templateAgents).not.toContain('**載入資源地圖**：`skill(name="model-selector")`')
    expect(templateAgents).not.toContain('**載入 MCP 擴充器**：`skill(name="mcp-finder")`')
    expect(templateAgents).not.toContain('**載入 Skill 擴充器**：`skill(name="skill-finder")`')
  })

  test("template prompts no longer treat model-selector as a default orchestrator dependency", async () => {
    const systemPrompt = await read("templates/system_prompt.md")
    const constitution = await read("templates/global_constitution.md")

    expect(systemPrompt).toContain("只有在任務真的需要額外模型策略分析時，才 on-demand 使用 `model-selector`")
    expect(systemPrompt).not.toContain("- `model-selector`: 用於動態分析任務並建議最佳模型策略。")

    expect(constitution).toContain("只有在任務真的需要額外模型策略分析時，才 on-demand 使用 `model-selector`")
    expect(constitution).not.toContain("- `model-selector`: 用於動態分析任務並建議最佳模型策略。")
  })

  test("beta-workflow skill is registered and mirrored in template/runtime locations", async () => {
    // templates/skills/ became a git submodule (commit 821f7fa4d); the retired
    // agent-workflow skill was folded into code-thinker, so only beta-workflow
    // is asserted here. The template SKILL.md is the source of truth; the
    // runtime copy may legitimately differ, so we assert the template contract
    // and that both enablement manifests register the skill.
    const templateSkill = await read("templates/skills/beta-workflow/SKILL.md")
    const runtimeEnablement = await read("packages/opencode/src/session/prompt/enablement.json")
    const templateEnablement = await read("templates/prompts/enablement.json")

    expect(templateSkill).toContain("name: beta-workflow")
    expect(templateSkill).toContain("mission.beta")
    expect(templateSkill).toContain("Do not implement from the authoritative `mainRepo` / `baseBranch`.")
    expect(runtimeEnablement).toContain('"beta-workflow"')
    expect(templateEnablement).toContain('"beta-workflow"')
  })
})
