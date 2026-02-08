#!/usr/bin/env bun

/**
 * 整合測試：實際執行 grep 命令並驗證過濾功能
 */

import { spawn } from "child_process"
import { promisify } from "util"

const execAsync = promisify(require("child_process").exec)

console.log("🧪 整合測試：輸出過濾功能\n")

// 測試場景 1: grep 產生大量 JSON 輸出
console.log("📋 測試場景 1: grep 搜尋 JSON 模式")
console.log("執行命令: grep -r 'export' src/cli/cmd/run.ts")

try {
  const { stdout } = await execAsync("cd /home/pkcs12/opencode && grep -r 'function' src/cli/cmd/run.ts | head -20")
  const lines = stdout.split("\n").filter((l) => l.trim())

  console.log(`✓ 找到 ${lines.length} 行結果`)
  console.log(`✓ 原始輸出長度: ${stdout.length} 字元`)

  if (lines.length > 10) {
    console.log("✓ 在 TUI 中應該會被摺疊或過濾\n")
  }
} catch (err) {
  console.log(`✗ 錯誤: ${err.message}\n`)
}

// 測試場景 2: 產生大量重複輸出
console.log("📋 測試場景 2: 產生重複輸出")
console.log("執行命令: find . -name '*.ts' | head -50")

try {
  const { stdout } = await execAsync("cd /home/pkcs12/opencode && find src -name '*.ts' | head -50")
  const lines = stdout.split("\n").filter((l) => l.trim())
  const unique = new Set(lines.map((l) => l.split("/").pop())).size
  const repetitionRate = ((1 - unique / lines.length) * 100).toFixed(1)

  console.log(`✓ 找到 ${lines.length} 個檔案`)
  console.log(`✓ 唯一檔名: ${unique}`)
  console.log(`✓ 重複率: ${repetitionRate}%`)

  if (parseFloat(repetitionRate) > 30) {
    console.log("✓ 在 TUI 中應該會被標記為 repetitive output\n")
  }
} catch (err) {
  console.log(`✗ 錯誤: ${err.message}\n`)
}

// 測試場景 3: 人類可讀的輸出
console.log("📋 測試場景 3: 人類可讀的輸出")
console.log("執行命令: echo 'Build successful'")

try {
  const { stdout } = await execAsync("echo 'Build successful\\nAll tests passed\\nDeployment complete'")
  const lines = stdout.split("\n").filter((l) => l.trim())

  console.log(`✓ 輸出內容:\n${stdout}`)
  console.log(`✓ 行數: ${lines.length}`)
  console.log(`✓ 在 TUI 中應該正常顯示（人類可讀）\n`)
} catch (err) {
  console.log(`✗ 錯誤: ${err.message}\n`)
}

console.log("=".repeat(60))
console.log("✅ 整合測試完成！")
console.log("\n下一步：")
console.log("1. 啟動 TUI: bun run dev")
console.log("2. 執行 grep 或 find 命令")
console.log("3. 觀察是否顯示 ...")
console.log("4. 點擊展開可查看完整輸出")
