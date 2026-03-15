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

    expect(projectAgents).toContain("唯一預設 workflow skill")
    expect(projectAgents).toContain("on-demand 裝備")
    expect(projectAgents).not.toContain("**`software-architect`**: 架構決策核心")
    expect(projectAgents).not.toContain("**`mcp-finder`**: MCP 擴充中樞")
    expect(projectAgents).not.toContain("**`skill-finder`**: Skill 擴充中樞")

    expect(templateAgents).toContain("只需載入最小必要底盤")
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

  test("agent-workflow skill mirrors delegation-first autorunner contract", async () => {
    const templateSkill = await read("templates/skills/agent-workflow/SKILL.md")

    expect(templateSkill).toContain("**Delegation-first。**")
    expect(templateSkill).toContain("**Narration ≠ Pause。**")
    expect(templateSkill).toContain("Delegation candidates")
    expect(templateSkill).toContain("narration 是 side-channel visibility")
  })
})
