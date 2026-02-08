#!/usr/bin/env bun

/**
 * 測試腳本：驗證輸出過濾功能
 *
 * 使用方式：
 *   bun test-output-filter.ts
 */

console.log("=== 測試輸出過濾功能 ===\n")

// 測試 1: 模擬 grep 大量 JSON 輸出
console.log("📝 測試 1: 大量 JSON 輸出")
const jsonOutput = Array(100)
  .fill(0)
  .map((_, i) => `{"path": "/home/test${i}.ts", "line": ${i + 1}, "content": "test"}`)
  .join("\n")

console.log(`原始輸出長度: ${jsonOutput.length} 字元`)
console.log(`原始輸出行數: ${jsonOutput.split("\n").length} 行`)
console.log("預期結果: 應該被過濾（JSON 結構化數據）\n")

// 測試 2: 模擬重複的列表輸出
console.log("📝 測試 2: 重複列表輸出")
const listOutput = Array(50)
  .fill(0)
  .map(() => "file1.txt\nfile2.txt")
  .join("\n")

console.log(`原始輸出行數: ${listOutput.split("\n").length} 行`)
const uniqueLines = new Set(listOutput.split("\n").map((l) => l.trim())).size
console.log(`唯一行數: ${uniqueLines}`)
console.log(`重複率: ${((1 - uniqueLines / listOutput.split("\n").length) * 100).toFixed(1)}%`)
console.log("預期結果: 應該被過濾（重複模式）\n")

// 測試 3: 人類可讀的錯誤訊息
console.log("📝 測試 3: 人類可讀的錯誤訊息")
const errorOutput = `Error: Failed to connect to database
Caused by: Connection timeout after 5000ms
Please check your network connection
Stack trace available in log file`

console.log(`原始輸出行數: ${errorOutput.split("\n").length} 行`)
console.log("預期結果: 應該正常顯示（人類可讀）\n")

// 測試 4: 超長單行輸出
console.log("📝 測試 4: 超長輸出")
const longOutput = "a".repeat(3000)

console.log(`原始輸出長度: ${longOutput.length} 字元`)
console.log("預期結果: 應該被過濾（超過 2000 字元）\n")

console.log("=== 測試完成 ===")
console.log("\n提示：")
console.log("- 在 TUI 模式下執行 grep 或 bash 命令")
console.log("- 觀察是否顯示 ...")
console.log("- 可以點擊展開查看完整輸出")
