# System Prompt Structure Datasheet

> Source: `@anthropic-ai/claude-code@2.1.92` (`GW` function)
> Extraction date: 2026-04-07

---

## 1. Overall Architecture

Official Claude CLI 的 system prompt 是一個 **string 陣列**，每個元素是一個 section（純文字），最終被 `qA7` 函數轉換成 `{ type: "text", text, cache_control }` 格式的 content blocks。

### Prompt = Static Sections + Boundary Marker + Dynamic Sections

```
┌─────────────────── STATIC (cacheable) ────────────────────┐
│                                                            │
│  [0] Identity + Coding Instructions (UpY)                  │
│  [1] System Prompt Prefix (QpY)                            │
│  [2] Coding Instructions (dpY)  ← conditional              │
│  [3] Tool Instructions (cpY)                               │
│  [4] Tool-Specific Rules (lpY)                             │
│  [5] Tone & Style (apY)                                    │
│  [6] Output Efficiency (opY)                               │
│                                                            │
├──────── __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ (NJ6) ──────────┤
│                                                            │
│  [7+] Dynamic Sections (per-session, loaded lazily):       │
│       - session_guidance (rpY)                             │
│       - memory (bl8)                                       │
│       - ant_model_override (BpY)                           │
│       - env_info_simple (glK)                              │
│       - language (gpY)                                     │
│       - output_style (FpY)                                 │
│       - bg-job-dir (tpY)                                   │
│       - scratchpad (epY)                                   │
│       - frc (qBY)                                          │
│       - summarize_tool_results (KBY)                       │
│       - brief (_BY)                                        │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### Key: Boundary Marker 的意義

`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`（`NJ6`）是 prompt caching 的分界線：

- **Boundary 之前** = Static sections → `cache_control: { type: "ephemeral", scope: "global" }` → **可被全局 cache**
- **Boundary 之後** = Dynamic sections → `cache_control: null` 或 per-request scope → **每次重算**

這是 prompt caching 省 token 的核心機制：static 部分（工具定義、coding instructions）在多輪對話中只計算一次。

---

## 2. Identity Selection Logic (`ZG8`)

```typescript
function selectIdentity(options) {
  if (platform === "vertex") return IDENTITY_INTERACTIVE  // Vertex 一律用 interactive
  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) return IDENTITY_AGENT_SDK
    return IDENTITY_PURE_AGENT
  }
  return IDENTITY_INTERACTIVE  // default
}
```

### Three Variants

| Variant | String | Condition |
|---|---|---|
| Interactive (default) | `"You are Claude Code, Anthropic's official CLI for Claude."` | Normal CLI usage |
| Agent SDK (appended) | `"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."` | Non-interactive + has append prompt |
| Pure Agent | `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` | Non-interactive, no append |

### Validation Set

Server 端用 `fG8 = new Set([TL1, Rtq, Stq])` 驗證 identity。**只有這三個字串被接受**。任何自訂 identity 都會被 server 拒絕（subscription auth 模式下）。

---

## 3. Cache Control Strategy (`qA7` + `cQ`)

### `cQ` Helper — Cache Control Block Generator

```typescript
function cQ({ scope, querySource } = {}) {
  return {
    type: "ephemeral",
    // 1h TTL only for specific allowlisted querySource on eligible accounts
    ...(isEligibleFor1hCache(querySource) && { ttl: "1h" }),
    // global scope for static sections
    ...(scope === "global" && { scope: "global" }),
  }
}
```

### 1-Hour TTL Eligibility

```typescript
function isEligibleFor1hCache(querySource) {
  // Bedrock: only if ENABLE_PROMPT_CACHING_1H_BEDROCK env set
  if (platform === "bedrock" && env.ENABLE_PROMPT_CACHING_1H_BEDROCK) return true
  // Must be OAuth AND not using overage
  if (!(isOAuth() && !isUsingOverage)) return false
  // Must match allowlist from tengu config
  const allowlist = getPromptCache1hAllowlist()
  return querySource && allowlist.some(pattern =>
    pattern.endsWith("*") ? querySource.startsWith(pattern.slice(0, -1)) : pattern === querySource
  )
}
```

### Three Cache Scope Modes (`qA7`)

#### Mode A: Tool-Based Cache (新功能，`skipGlobalCacheForSystemPrompt = true`)

```
Block 1: billing header          → cacheScope: null (no cache)
Block 2: identity string         → cacheScope: "org" (organization-level)
Block 3: all other sections      → cacheScope: "org"
```

#### Mode B: Boundary-Based Cache (有 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker)

```
Block 1: billing header          → cacheScope: null
Block 2: identity string         → cacheScope: null
Block 3: static sections (before boundary) → cacheScope: "global"
Block 4: dynamic sections (after boundary) → cacheScope: null
```

#### Mode C: Fallback (無 boundary marker)

```
Block 1: billing header          → cacheScope: null
Block 2: identity string         → cacheScope: "org"
Block 3: all other sections      → cacheScope: "org"
```

### 最終轉換 (`EBY`)

```typescript
function toSystemBlocks(promptSections, enableCaching, options) {
  return qA7(promptSections, options).map(section => ({
    type: "text",
    text: section.text,
    ...(enableCaching && section.cacheScope !== null && {
      cache_control: cQ({
        scope: section.cacheScope,
        querySource: options?.querySource
      })
    })
  }))
}
```

---

## 4. Section Details

### Static Sections (cached)

| Section | Function | Content |
|---|---|---|
| Identity + Instructions | `UpY(outputStyle)` | Identity string (from `ZG8`) + base instructions |
| System Prefix | `QpY()` | "# System" header + base behavioral rules |
| Coding Instructions | `dpY()` | Detailed coding guidelines (conditional on output style) |
| Tool Instructions | `cpY()` | How to use tools, Bash/Read/Edit/Write/Grep/Glob etc. |
| Tool-Specific Rules | `lpY(toolNames)` | Rules specific to which tools are loaded |
| Tone & Style | `apY()` | Emoji rules, conciseness, file path format, PR format |
| Output Efficiency | `opY()` | "Go straight to the point" brevity rules |

### Dynamic Sections (not cached, loaded lazily via `Ex`)

| Section | Key | Function | Content |
|---|---|---|---|
| Session Guidance | `session_guidance` | `rpY(tools, isGit)` | Git workflow, commit rules, PR rules |
| Memory | `memory` | `bl8()` | CLAUDE.md files, auto-memory |
| Model Override | `ant_model_override` | `BpY()` | Internal Anthropic model override |
| Environment Info | `env_info_simple` | `glK(model, dirs)` | CWD, platform, shell, model name, knowledge cutoff |
| Language | `language` | `gpY(lang)` | User's preferred language |
| Output Style | `output_style` | `FpY(style)` | Custom output style rules |
| Background Job Dir | `bg-job-dir` | `tpY()` | Background job working directory |
| Scratchpad | `scratchpad` | `epY()` | Scratchpad directory for temp files |
| FRC | `frc` | `qBY(model)` | Feature-related config (currently returns null) |
| Tool Summary | `summarize_tool_results` | `KBY` | Tool result summarization rules |
| Brief Mode | `brief` | `_BY()` | Brief mode instructions (if enabled) |

### `Ex` — Lazy Section Loader

```typescript
function Ex(key, fn) {
  return { key, load: fn }  // Only called when building prompt
}
```

Dynamic sections are loaded in parallel via `Promise.all` → `TWK(sections)`.

---

## 5. Billing Header as System Prompt Section

**Important**: The billing header (`x-anthropic-billing-header: cc_version=...`) is embedded as the **first text element** in the system prompt array, NOT just as an HTTP header.

```
System blocks:
  [0] { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.92.a3f; ...", cache_control: null }
  [1] { type: "text", text: "You are Claude Code, ...",  cache_control: { type: "ephemeral", scope: "org" } }
  [2] { type: "text", text: "# System\n...",             cache_control: { type: "ephemeral", scope: "global" } }
  ...
```

This is a **critical fingerprint element** — the billing header appears in both the HTTP header AND the system prompt.

---

## 6. OpenCode 的客製化空間分析

### 不可改（fingerprint 必須一致）

| 元素 | 原因 |
|---|---|
| Identity string（3 variants 之一） | Server 端 validation set 驗證 |
| Billing header（格式 + 位置） | 出現在 system prompt block[0] + HTTP header |
| Identity 在 system[1] 位置 | Server 驗證 |

### 可以改（不影響 fingerprint）

| 元素 | 自由度 |
|---|---|
| Static sections 2-6 的內容 | 完全可自訂（coding instructions、tone、tool rules） |
| Dynamic sections 全部 | 完全可自訂（memory、env info、session guidance） |
| 新增自訂 section | 可以加在 static 或 dynamic 區 |
| Section 順序 | Static 區內可調（但建議保持原序以利 cache hit） |
| Boundary marker 位置 | 決定 cache 分界線 |

### 影響 Prompt Caching 的關鍵決策

1. **Static 區要盡量穩定** — 每次變動都會導致 cache miss，重新計算 tokens
2. **Boundary marker 的放置** — 之前的內容被 global cache，之後不被 cache
3. **`cache_control.scope`** — `"global"` 跨 session cache；`"org"` 組織級 cache；`null` 不 cache
4. **Block 數量** — 每個 block 獨立計算 cache，太多小 block 降低 cache hit rate
5. **OpenCode 自訂內容應放在 dynamic 區** — 避免污染 static cache

### 建議的 OpenCode System Prompt 結構

```
[0] billing header                           → cache: null
[1] identity (MUST be official variant)       → cache: org
[2] official coding instructions (from CLI)   → cache: global  ← 最大 cache 效益
[3] tool instructions (from CLI)              → cache: global
[4] tone & style (from CLI)                   → cache: global
[5] output efficiency (from CLI)              → cache: global
    ──── __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ ────
[6] OpenCode-specific instructions            → cache: null
[7] session guidance                          → cache: null
[8] memory (CLAUDE.md, auto-memory)           → cache: null
[9] environment info                          → cache: null
[10] user language preference                 → cache: null
```

**關鍵原則**：official sections 保持原樣放 static 區 → 最大化 prompt cache hit rate。OpenCode 自己的 instructions 放 dynamic 區。
