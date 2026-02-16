# RCA: Global 模組水合 (Hydration) 問題

**日期**: 2026-02-09  
**嚴重度**: High (影響測試環境，可能影響熱加載)  
**影響**: 測試超時 (>120s), 模組載入緩慢

---

## 1. 問題描述

### 症狀
- 測試執行超時 (>120 秒)
- `import('./src/plugin/antigravity/plugin/storage.ts')` 等正常操作亦超時
- 直接 `python3 -c "import os; print(os.getcwd())"` 則快速響應 (< 1s)

### 根本原因
`src/global/index.ts` 在 **top-level scope** 執行大量 async/await 操作

```typescript
// 行 48-60: 路徑解析 (Promise 串聯)
const resolvedPaths: DirectorySet = await (async () => {
  try {
    await ensurePaths(defaultPaths)  // 創建多個目錄
    return defaultPaths
  } catch (error) {
    await ensurePaths(fallbackPaths)  // 備選路徑
    return fallbackPaths
  }
})()

// 行 81-88: 並行創建 6 個目錄
await Promise.all([
  fs.mkdir(Global.Path.user, { recursive: true }),
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
])

// 行 138-150+: 載入並處理 manifest (可能 I/O 密集)
const manifestEntries = await loadManifestEntries()
await Promise.all(
  templateEntries.map(async (entry) => {
    // 安裝模板檔案...
  })
)
```

### 影響範圍
每個 import `src/global/index.ts` 的模組都會被阻塞直到初始化完成：

```
dependency chain:
storage.ts
  → logger.ts (imports Global)
    → global/index.ts (TOP-LEVEL AWAIT - 100-500ms wait)
      ↓
  → accounts.ts
    → global/index.ts (重複等待)
```

---

## 2. 技術根源

### ES Module Top-Level Await
TypeScript/Bun 支援 ES Module 的 top-level await，但不適合關鍵初始化：

```typescript
// ❌ BAD: 模組導入會被 block
import { Global } from "../global"
// 此時 Global.Path 未必初始化完成（取決於 await 完成時間）
```

### 依賴注入缺失
- `Global.Path.log`, `Global.Path.config` 等被當作靜態資源
- 實際上它們是動態初始化的結果
- 無法在測試環境中 mock 或替換

---

## 3. 影響評估

### 生產環境
- ✅ **影響低**: 啟動時只執行 1 次
- ⚠️ **潛在**: 模組熱加載 / 動態 import 時可能延遲

### 測試環境
- 🔴 **影響高**: 每個測試都重新執行初始化
- 🔴 **超時**: 測試框架無法忍受 100+ ms 的額外延遲
- 🔴 **隔離困難**: 無法模擬不同的路徑環境

### 開發效率
- ⚠️ **迭代遲鈍**: 開發時 import 路徑等待
- ⚠️ **REPL 響應**: Node REPL / Bun REPL 互動緩慢

---

## 4. 解決方案 (3 選項)

### 方案 A: 延遲初始化 (推薦) ✅

**目標**: 不在模組載入時執行初始化，改為首次使用時

**實施**:

```typescript
// src/global/index.ts

let initialized = false
let resolvedPathsCache: DirectorySet | null = null

async function ensureInitialized() {
  if (initialized) return
  
  try {
    resolvedPathsCache = await (async () => {
      try {
        await ensurePaths(defaultPaths)
        return defaultPaths
      } catch (error) {
        if (isAccessDenied(error)) {
          await fs.mkdir(fallbackRoot, { recursive: true }).catch(() => {})
          await ensurePaths(fallbackPaths)
          return fallbackPaths
        }
        throw error
      }
    })()
    
    // 並行創建目錄
    if (resolvedPathsCache) {
      await Promise.all([ /* ... */ ])
    }
    
    // 安裝模板檔案
    await installTemplates()
    
    initialized = true
  } catch (error) {
    console.error("Failed to initialize Global paths", error)
    throw error
  }
}

export namespace Global {
  export const Path = {
    get home() { return process.env.OPENCODE_TEST_HOME || os.homedir() },
    get user() { return this.config },
    get data() {
      if (!resolvedPathsCache) throw new Error("Global paths not initialized. Call Global.initialize() first.")
      return resolvedPathsCache.data
    },
    // ... 其他 getter
  }
  
  export async function initialize() {
    await ensureInitialized()
  }
}
```

**優點**:
- ✅ 模組載入速度快 (0 ms)
- ✅ 首次使用時執行 (可 mock / 延遲)
- ✅ 測試時可控制初始化

**缺點**:
- ⚠️ 需要調用 `Global.initialize()`
- ⚠️ 如果忘記呼叫，會拋出錯誤

---

### 方案 B: 預初始化 (Eager Initialization)

**目標**: 在主程式進入前執行初始化，不在 import 時執行

**實施**:

```typescript
// src/main.ts
import { Global } from "./global"

// 主程式入口
async function main() {
  await Global.initialize()
  
  // ... 實際業務邏輯
}

main().catch(console.error)
```

**優點**:
- ✅ 測試可以忽略初始化
- ✅ 生產環境一次性初始化

**缺點**:
- ⚠️ 需要找到 main 入口
- ⚠️ 可能有多個 entry point

---

### 方案 C: 分解模組

**目標**: 將靜態部分和動態部分分離

**實施**:

```typescript
// src/global/paths.ts (靜態)
export const staticPaths = {
  home: os.homedir(),
  // 不依賴 await
}

// src/global/index.ts (動態)
export namespace Global {
  export const Path = {
    get home() { return staticPaths.home },
    // ... dynamic paths using lazy init
  }
  export async function initialize() { /* ... */ }
}
```

**優點**:
- ✅ 最靈活的解決方案
- ✅ 支援不同初始化策略

**缺點**:
- ⚠️ 需要大量重構
- ⚠️ 複雜度高

---

## 5. 建議實施 (短期 vs 長期)

### 短期 (本 Session)
- 分析並記錄問題 ✅ (此文檔)
- 制定預防措施
- 提出 PR (無需實施，討論用)

### 長期 (未來 PR)
1. 實施方案 A (延遲初始化)
   - 改動最小
   - 風險最低
   - 需要在 main 或 entry 呼叫 `Global.initialize()`

2. 測試環境改進
   - `test/preload.ts` 調用 `Global.initialize()`
   - Mock Global.Path 用於單元測試

3. 性能基準
   - 比較初始化前後的模組載入時間
   - 確保主程式啟動時間無回歸

---

## 6. 相關檔案

| 檔案 | 行數 | 問題 |
|------|------|------|
| `src/global/index.ts` | 48-60 | resolvedPaths await |
| `src/global/index.ts` | 81-88 | mkdir Promise.all |
| `src/global/index.ts` | 138-160+ | template loading await |
| `test/preload.ts` | TBD | 無初始化調用 |

---

## 7. 驗證計劃

### 方案 A 驗證
```bash
# 1. 修改 src/global/index.ts (延遲初始化)
# 2. 修改 src/main.ts / CLI entry 呼叫 Global.initialize()
# 3. 修改 test/preload.ts 呼叫 Global.initialize()
# 4. 執行測試
bun test src/plugin/antigravity/plugin/persist-account-pool.test.ts
# 預期: 測試在 5-10 秒內完成 (vs 現在的 120+ 秒超時)
```

---

## 8. 風險評估

### 採取行動的風險
- 🟡 **Low**: 延遲初始化只改變執行時序，不改變結果
- 🟡 **Low**: 測試預初始化很簡單

### 不採取行動的風險
- 🔴 **High**: 測試環境持續超時
- 🔴 **High**: 新開發者無法執行測試

---

**簽署**: OpenCode Technical Debt Review  
**下一步**: 實施方案 A (延遲初始化) - 預期 2-3 小時工作量
