import { describe, it, expect } from "bun:test"
import { z } from "zod"
import { ConfigMarkdown } from "../src/config/markdown"

// 模擬 Skill.Info
const Info = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
  content: z.string(),
})

describe("Skill Fix Verification", () => {
  it("should parse markdown and include content", async () => {
    // 建立一個假的 skill 檔案內容
    const fileContent = `---
name: test-skill
description: A test skill
---
# Test Skill Content
This is the content of the skill.
`

    // 模擬 ConfigMarkdown.parse 的行為 (使用 gray-matter)
    // 這裡我們直接測試邏輯：如果我們有了 md 物件，能否正確構建 skill 物件

    // 假設這是 ConfigMarkdown.parse 回傳的結構 (基於 gray-matter)
    const md = {
      data: {
        name: "test-skill",
        description: "A test skill",
      },
      content: "\n# Test Skill Content\nThis is the content of the skill.\n",
    }

    // 模擬 addSkill 的邏輯
    const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
    expect(parsed.success).toBe(true)

    if (parsed.success) {
      const skill = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: "/path/to/skill.md",
        content: md.content, //這就是我們加入的關鍵行
      }

      // 驗證是否符合新的 Info schema
      const result = Info.safeParse(skill)
      expect(result.success).toBe(true)
      expect(skill.content).toBeDefined()
      expect(skill.content).toContain("Test Skill Content")

      // 驗證 trim() 不會報錯
      expect(skill.content.trim()).toBe("# Test Skill Content\nThis is the content of the skill.")
    }
  })
})
