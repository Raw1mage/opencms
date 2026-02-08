/**
 * 智能判斷內容是否適合在對話中顯示
 * 過濾大量非人類可讀的內容，保持對話清潔
 */
export function isHumanReadable(content: string): { readable: boolean; reason?: string } {
  if (!content || content.trim().length === 0) {
    return { readable: false }
  }

  const lines = content.split("\n")
  const totalChars = content.length

  // 規則 1: 過長內容（可能是大量數據輸出）
  if (lines.length > 50 || totalChars > 2000) {
    return { readable: false, reason: `${lines.length} lines` }
  }

  // 規則 2: Minified code 檢測（單行超長）
  const maxLineLength = Math.max(...lines.map((l) => l.length))
  if (maxLineLength > 500) {
    return { readable: false, reason: "minified code" }
  }

  // 規則 3: 多行超長檢測（可能是 minified/obfuscated code）
  const longLines = lines.filter((l) => l.length > 200).length
  if (longLines > lines.length * 0.5) {
    return { readable: false, reason: "minified/obfuscated code" }
  }

  // 規則 4: 檢測 JSON/XML 結構化數據
  const jsonLikePatterns = [
    /^\s*[\{\[]/, // 開頭是 { 或 [
    /"[^"]+"\s*:\s*/, // JSON key-value
    /<[^>]+>.*<\/[^>]+>/, // XML tags
  ]
  const jsonLikeLines = lines.filter((line) => jsonLikePatterns.some((pattern) => pattern.test(line)))
  if (jsonLikeLines.length > lines.length * 0.5) {
    return { readable: false, reason: "JSON/XML data" }
  }

  // 規則 5: 檢測大量相似的重複模式（如列表輸出）
  const uniqueLines = new Set(lines.map((l) => l.trim())).size
  if (lines.length > 10 && uniqueLines / lines.length < 0.3) {
    return { readable: false, reason: "repetitive output" }
  }

  // 規則 6: 檢測 Base64 或二進制數據
  const binaryPatterns = [/^[A-Za-z0-9+/=]{50,}$/, /\\x[0-9a-fA-F]{2}/]
  const binaryLines = lines.filter((line) => binaryPatterns.some((pattern) => pattern.test(line)))
  if (binaryLines.length > 5) {
    return { readable: false, reason: "binary data" }
  }

  return { readable: true }
}
