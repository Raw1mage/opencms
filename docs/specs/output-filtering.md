# 智能輸出過濾系統 (Intelligent Output Filtering)

## 設計原則

**「對話框是與人類溝通的空間，不是 Debug Console」**

本系統透過雙層防護機制，確保用戶在對話中只看到有意義的內容，而非大量技術性中間產物。

---

## 第 1 層：System Prompt 約束

位置：`/home/pkcs12/.config/opencode/AGENTS.md`

### 對話清潔原則 (Dialogue Hygiene)

**嚴禁在對話中輸出：**

- ✗ 大段 JSON 輸出
- ✗ 完整的檔案內容（除非用戶明確要求）
- ✗ 冗長的工具執行結果
- ✗ Stack Trace（應摘要關鍵錯誤訊息）

**必須轉化為人類可讀的摘要：**

- ✓ 「找到 50 個符合的檔案」
- ✓ 「檢測到 3 個 Type Error，已修復」
- ✓ 「已完成 XYZ 功能，測試通過」

---

## 第 2 層：程式碼智能過濾

位置：`/home/pkcs12/opencode/src/cli/cmd/run.ts`

### `isHumanReadable()` 函數

自動判斷內容是否適合顯示，基於以下規則：

#### 規則 1: 長度檢測

```typescript
if (lines.length > 50 || totalChars > 2000) {
  return { readable: false, reason: "50+ lines or 2000+ chars" }
}
```

#### 規則 2: 結構化數據檢測

檢測 JSON、XML 等非敘述性內容：

```typescript
const jsonLikePatterns = [
  /^\s*[\{\[]/, // 開頭是 { 或 [
  /"[^"]+"\s*:\s*/, // JSON key-value
  /<[^>]+>.*<\/[^>]+>/, // XML tags
]
```

如果超過 50% 的行符合結構化模式，則隱藏。

#### 規則 3: 重複模式檢測

檢測大量相似的列表輸出：

```typescript
const uniqueLines = new Set(lines.map((l) => l.trim())).size
if (lines.length > 10 && uniqueLines / lines.length < 0.3) {
  return { readable: false, reason: "repetitive output" }
}
```

#### 規則 4: 二進制數據檢測

```typescript
const binaryPatterns = [
  /^[A-Za-z0-9+/=]{50,}$/, // Base64
  /\\x[0-9a-fA-F]{2}/, // Hex escape
]
```

### 輸出範例

**原始輸出（被過濾）：**

```bash
$ grep -r "v1/messages"
{"path": "/home/...", "line": 123, "content": "..."}
{"path": "/home/...", "line": 456, "content": "..."}
[... 100+ lines of JSON ...]
```

**實際顯示（過濾後）：**

```
$ grep -r "v1/messages" · Search for patterns in files
...
```

---

## 效果對比

### 修改前

```
$ grep -rn "thinking"
/home/pkcs12/opencode/src/plugin/antigravity/plugin/request.ts:890:...
/home/pkcs12/opencode/src/plugin/antigravity/plugin/request.ts:997:...
/home/pkcs12/opencode/src/plugin/antigravity/plugin/request.ts:1131:...
[... 500 行輸出 ...]
```

### 修改後

```
$ grep -rn "thinking" · Search for patterns in files
...
```

對於**人類可讀**的簡短輸出，仍會正常顯示：

```
$ cat README.md · Read file
# OpenCode

Welcome to OpenCode!
```

---

## 調整參數

如需調整過濾器的敏感度，可修改以下常數：

```typescript
// 在 /home/pkcs12/opencode/src/cli/cmd/run.ts 中

function isHumanReadable(content: string) {
  // 調整這些值
  const MAX_LINES = 50 // 最大行數
  const MAX_CHARS = 2000 // 最大字元數
  const JSON_THRESHOLD = 0.5 // JSON 判定閾值（0.0-1.0）
  const UNIQUE_RATIO = 0.3 // 重複判定閾值（0.0-1.0）

  // ...
}
```

---

## 特殊情況

### 如何查看被過濾的內容？

1. **查看原始工具輸出**：在 Session Transcript 中查看
2. **使用 `--format json` 參數**：完整輸出所有工具執行結果
3. **直接執行命令**：在終端執行相同的 bash 命令

### 哪些工具會被過濾？

- `bash`: 智能過濾
- `grep`: 智能過濾
- `glob`: 僅顯示摘要（已內建）
- `read`: 智能過濾
- `write`: 智能過濾
- `edit`: 顯示 diff（保留）
- `webfetch`: 智能過濾

---

## 維護建議

### 如何新增過濾規則？

在 `isHumanReadable()` 中新增檢測邏輯：

```typescript
// 規則 5: 檢測 SQL 輸出
const sqlPattern = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)/i
if (lines.some((line) => sqlPattern.test(line))) {
  return { readable: false, reason: "SQL query" }
}
```

### 如何針對特定工具客製化？

在各工具的顯示函數中覆寫行為：

```typescript
function myCustomTool(info: ToolProps<typeof MyTool>) {
  // 完全自訂顯示邏輯
  inline({
    icon: "⚡",
    title: "My Tool",
    description: "Custom description",
  })
  // 不呼叫 block()，則不會顯示任何輸出
}
```

---

**最後更新：2026-02-08**
