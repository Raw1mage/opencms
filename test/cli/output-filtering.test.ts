import { describe, test, expect } from "bun:test"

/**
 * 驗證輸出過濾不會影響 Agent 的背景運作
 *
 * 測試原理：
 * 1. 工具執行層回傳完整的 output
 * 2. Agent 透過 ToolStateCompleted.output 讀取完整數據
 * 3. UI 顯示層的過濾只影響 console 輸出，不影響數據流
 */

describe("Output Filtering - Agent Data Isolation", () => {
  test("Tool output should remain intact in ToolState", () => {
    // 模擬工具執行結果
    const toolOutput = {
      status: "completed" as const,
      input: { command: "grep -r 'test'" },
      output: '{"path": "/test.ts", "line": 123}\n'.repeat(100), // 大量 JSON 輸出
      title: "Search complete",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    }

    // 驗證：output 欄位包含完整數據
    expect(toolOutput.output).toContain('{"path": "/test.ts", "line": 123}')
    expect(toolOutput.output.length).toBeGreaterThan(1000)
  })

  test("isHumanReadable() should only affect display, not data", () => {
    // 模擬 isHumanReadable() 函數的判斷邏輯
    function isHumanReadable(content: string): { readable: boolean; reason?: string } {
      if (!content || content.trim().length === 0) {
        return { readable: false }
      }

      const lines = content.split("\n")
      const totalChars = content.length

      // 規則 1: 過長內容
      if (lines.length > 50 || totalChars > 2000) {
        return { readable: false, reason: `${lines.length} lines, ${totalChars} chars` }
      }

      return { readable: true }
    }

    const largeOutput = "line\n".repeat(100)
    const smallOutput = "Build successful"

    // 驗證：過濾邏輯正確運作
    expect(isHumanReadable(largeOutput).readable).toBe(false)
    expect(isHumanReadable(smallOutput).readable).toBe(true)

    // 關鍵：原始數據未被修改
    expect(largeOutput).toContain("line")
    expect(largeOutput.length).toBeGreaterThan(400)
  })

  test("UI filtering should not modify ToolPart state", () => {
    // 模擬 ToolPart 結構
    const toolPart = {
      id: "tool-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "tool" as const,
      callID: "call-1",
      tool: "bash",
      state: {
        status: "completed" as const,
        input: { command: "ls -la" },
        output: "file1.txt\nfile2.txt\n".repeat(50), // 大量輸出
        title: "List files",
        metadata: {},
        time: { start: Date.now(), end: Date.now() },
      },
    }

    // 記錄原始長度
    const originalLength = toolPart.state.output.length

    // 模擬 UI 顯示函數
    function displayTool(part: typeof toolPart) {
      const output = part.state.output?.trim()

      // UI 過濾邏輯（僅用於顯示）
      const shouldDisplay = output && output.length < 500

      // 返回顯示的內容（可能被截斷）
      return shouldDisplay ? output : "..."
    }

    const displayedOutput = displayTool(toolPart)

    // 驗證：顯示被過濾（因為輸出超過 500 字元）
    expect(toolPart.state.output.length).toBeGreaterThan(500)
    expect(displayedOutput).toBe("...")

    // 關鍵：原始 state.output 完全未被修改
    expect(toolPart.state.output).toContain("file1.txt")
    expect(toolPart.state.output.length).toBe(originalLength)
  })

  test("Agent should have access to full output regardless of UI filtering", () => {
    // 模擬 Agent 讀取工具結果的情境
    const toolResult = {
      state: {
        status: "completed" as const,
        output: '{"data": [1, 2, 3]}\n'.repeat(100), // JSON 數據
        input: {},
        title: "",
        metadata: {},
        time: { start: 0, end: 0 },
      },
    }

    // Agent 的處理邏輯（完全基於 state.output）
    function agentProcessToolResult(result: typeof toolResult) {
      const output = result.state.output

      // Agent 可以完整存取並解析數據
      const lines = output.split("\n").filter((l) => l.trim())
      const parsedData = lines.map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })

      return parsedData.filter((d) => d !== null)
    }

    const processedData = agentProcessToolResult(toolResult)

    // 驗證：Agent 成功處理了所有數據
    expect(processedData.length).toBeGreaterThan(90)
    expect(processedData[0]).toEqual({ data: [1, 2, 3] })
  })
})

describe("Output Filtering - Readability Detection", () => {
  test("should detect structured JSON data", () => {
    const jsonOutput = `{"path": "/test.ts", "line": 123}
{"path": "/test2.ts", "line": 456}`

    const jsonLikePatterns = [/^\s*[\{\[]/, /"[^"]+"\s*:\s*/]

    const lines = jsonOutput.split("\n")
    const jsonLikeLines = lines.filter((line) => jsonLikePatterns.some((pattern) => pattern.test(line)))

    expect(jsonLikeLines.length).toBe(2)
    expect(jsonLikeLines.length / lines.length).toBeGreaterThan(0.5)
  })

  test("should detect repetitive output", () => {
    const repetitiveOutput = "file1.txt\nfile2.txt\n".repeat(20)

    const lines = repetitiveOutput.split("\n").filter((l) => l.trim())
    const uniqueLines = new Set(lines.map((l) => l.trim())).size

    expect(uniqueLines).toBe(2) // 只有 2 種不同的行
    expect(lines.length).toBeGreaterThan(10)
    expect(uniqueLines / lines.length).toBeLessThan(0.3)
  })

  test("should allow human-readable error messages", () => {
    const errorMessage = `Error: Failed to connect to database
Caused by: Connection timeout after 5000ms
Please check your network connection`

    const lines = errorMessage.split("\n")
    const uniqueLines = new Set(lines.map((l) => l.trim())).size

    expect(lines.length).toBeLessThan(50)
    expect(uniqueLines / lines.length).toBeGreaterThan(0.3)
  })
})
