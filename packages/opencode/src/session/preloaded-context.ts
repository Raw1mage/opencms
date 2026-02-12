import path from "path"
import fs from "fs/promises"
import { Instance } from "../project/instance"
import { Global } from "../global"

export async function getPreloadedContext(_sessionID?: string): Promise<string> {
  const root = Instance.worktree
  let listing = ""
  try {
    const files = await fs.readdir(root)
    listing = files.slice(0, 50).join("\n")
    if (files.length > 50) listing += "\n... (truncated)"
  } catch (e) {
    listing = String(e)
  }

  let readme = ""
  try {
    const candidates = ["README.md", "readme.md", "README.txt", "README"]
    for (const candidate of candidates) {
      const p = path.join(root, candidate)
      const exists = await fs
        .stat(p)
        .then(() => true)
        .catch(() => false)
      if (exists) {
        readme = await fs.readFile(p, "utf-8")
        readme = readme.slice(0, 1000)
        break
      }
    }
  } catch {
    readme = "Error reading README"
  }

  let skills = ""
  const skillNames = ["model-selector", "agent-workflow"]
  const skillDirs = [path.join(root, ".opencode", "skills"), path.join(Global.Path.data, "skills")]

  for (const name of skillNames) {
    let content = ""
    for (const dir of skillDirs) {
      const p = path.join(dir, name, "SKILL.md")
      const exists = await fs
        .stat(p)
        .then(() => true)
        .catch(() => false)
      if (exists) {
        content = await fs.readFile(p, "utf-8")
        break
      }
    }
    if (content) {
      skills += `\n<skill name="${name}">\n${content}\n</skill>`
    }
  }

  return `
<preloaded_context>
<env_context>
<cwd_listing>
${listing}
</cwd_listing>
<readme_summary>
${readme}
</readme_summary>
</env_context>
<skill_context>
${skills}
</skill_context>
</preloaded_context>

Current directory, README, and core skills are already provided in <preloaded_context>. DO NOT run ls, read README, or load core skills.
`
}
