# Admin System Plugin Design

## Overview

This document outlines the design for extracting the cms branch's admin management system into an independent plugin that can be optionally installed on top of origin/dev.

---

# Part 1: Google Provider Suite (Free Resource Maximization)

## Design Philosophy

cms 分支將 Google Provider 拆分成三個獨立的 provider，每個模仿不同的 client identity：

| Provider | Client Identity | Purpose |
|----------|-----------------|---------|
| `google-api` | Google AI Studio | API Key 直接存取 |
| `gemini-cli` | Gemini CLI Tool | 模仿官方 CLI 的 OAuth |
| `antigravity` | Antigravity IDE Extension | 模仿 VS Code 擴展的 OAuth |

**目的**：每個 client identity 在 Google 端有獨立的 rate limit 配額，分開使用可獲得額外的免費資源。

## Client Identity Comparison

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Google Provider Suite                              │
├───────────────┬──────────────────┬───────────────────────────────────────┤
│  google-api   │   gemini-cli     │          antigravity                  │
├───────────────┼──────────────────┼───────────────────────────────────────┤
│ Auth: API Key │ Auth: OAuth PKCE │ Auth: OAuth PKCE                      │
│               │                  │                                        │
│ Client ID:    │ Client ID:       │ Client ID:                            │
│ (none)        │ 681255809395-... │ 1071006060591-...                     │
│               │                  │                                        │
│ Redirect:     │ Redirect:        │ Redirect:                             │
│ (none)        │ :8085            │ :51121                                │
│               │                  │                                        │
│ Endpoint:     │ Endpoint:        │ Endpoints (fallback):                 │
│ ai.googleapis │ cloudcode-pa     │ daily-sandbox → autopush → prod       │
│               │                  │                                        │
│ Headers:      │ Headers:         │ Headers:                              │
│ minimal       │ nodejs-client    │ antigravity/vscode                    │
│               │                  │                                        │
│ Multi-account:│ Multi-account:   │ Multi-account:                        │
│ ❌            │ ❌               │ ✅ (AccountManager + rotation)        │
│               │                  │                                        │
│ Rate Limit:   │ Rate Limit:      │ Rate Limit:                           │
│ manual        │ manual           │ auto-rotation + cooldown              │
└───────────────┴──────────────────┴───────────────────────────────────────┘
```

## Unified Google Provider Plugin (`@opencode/google-provider-suite`)

將三個 provider 整合成單一模組：

```
src/plugin/google-provider-suite/
├── index.ts                    # Plugin entry, exports all 3 providers
├── shared/
│   ├── types.ts               # Shared type definitions
│   ├── account-store.ts       # Unified account storage (all 3 types)
│   ├── token-refresh.ts       # Token refresh logic
│   └── rate-limit-tracker.ts  # Rate limit tracking
├── google-api/
│   ├── provider.ts            # API Key provider
│   └── auth.ts                # API Key validation
├── gemini-cli/
│   ├── provider.ts            # Gemini CLI OAuth provider
│   ├── oauth.ts               # OAuth flow (client ID: 681255...)
│   ├── constants.ts           # Headers, endpoints
│   └── request.ts             # Request transformation
├── antigravity/
│   ├── provider.ts            # Antigravity OAuth provider
│   ├── oauth.ts               # OAuth flow (client ID: 1071006...)
│   ├── constants.ts           # Headers, endpoints, system prompts
│   ├── request.ts             # Request transformation
│   ├── account-manager.ts     # Multi-account rotation
│   ├── rotation.ts            # Health tracking, rotation logic
│   └── endpoint-selector.ts   # daily → autopush → prod fallback
└── admin/
    └── google-accounts.tsx    # Unified admin UI for all 3 types
```

## Unified Account Model

```typescript
// All Google-based accounts in one structure
interface GoogleAccountStore {
  version: 2;

  // API Key accounts (google-api provider)
  apiAccounts: Record<string, {
    name: string;
    apiKey: string;
    addedAt: number;
  }>;

  // Gemini CLI OAuth accounts (gemini-cli provider)
  geminiCliAccounts: Record<string, {
    email: string;
    refreshToken: string;
    accessToken?: string;
    expiresAt?: number;
    projectId?: string;
    addedAt: number;
  }>;

  // Antigravity OAuth accounts (antigravity provider - multi-account + rotation)
  antigravityAccounts: {
    accounts: Array<{
      email?: string;
      refreshToken: string;
      accessToken?: string;
      expiresAt?: number;
      projectId?: string;
      managedProjectId?: string;
      enabled: boolean;
      rateLimitResetTimes: Record<string, number>;
      coolingDownUntil?: number;
      cooldownReason?: string;
      fingerprint?: Record<string, unknown>;
      addedAt: number;
    }>;
    activeIndex: number;
    activeIndexByFamily: {
      claude: number;
      gemini: number;
    };
  };

  // Which provider to use by default
  defaultProvider: "google-api" | "gemini-cli" | "antigravity";
}
```

## Admin UI Integration

```
┌─────────────────────────────────────────────────────────────────┐
│                    Admin Control Panel                          │
├─────────────────────────────────────────────────────────────────┤
│ ⭐ Favorites                                                    │
│ 🕐 Recents                                                      │
├─────────────────────────────────────────────────────────────────┤
│ 📂 Anthropic          1 account                              ● │
│ 📂 OpenAI             2 accounts                             ● │
│ 📂 Google Suite       5 accounts (3 types)                   ● │
│    ├── 🔑 API Keys (2)                                         │
│    │   ├── personal-key                                     ● │
│    │   └── work-key                                           │
│    ├── 🖥️ Gemini CLI (1)                                       │
│    │   └── user@gmail.com                                   ● │
│    └── 🚀 Antigravity (2)                                      │
│        ├── account-1@gmail.com                              ● │
│        └── account-2@gmail.com                      ⏳ 5m     │
│ 📂 GitHub Copilot     1 account                              ● │
└─────────────────────────────────────────────────────────────────┘
```

## Rate Limit Strategy

```typescript
// Intelligent provider selection based on rate limits
async function selectBestGoogleProvider(modelId: string): Promise<string> {
  const store = await loadGoogleAccountStore();

  // 1. Check Antigravity accounts first (most accounts, auto-rotation)
  const agAvailable = store.antigravityAccounts.accounts.find(
    acc => acc.enabled && (!acc.coolingDownUntil || acc.coolingDownUntil < Date.now())
  );
  if (agAvailable) return "antigravity";

  // 2. Fallback to Gemini CLI
  const gcAvailable = Object.values(store.geminiCliAccounts).length > 0;
  if (gcAvailable) return "gemini-cli";

  // 3. Fallback to API Key
  const apiAvailable = Object.values(store.apiAccounts).length > 0;
  if (apiAvailable) return "google-api";

  throw new Error("No available Google provider");
}
```

## File Mapping (Google Suite)

| Current cms Path | Target in Plugin |
|------------------|------------------|
| `src/plugin/antigravity/` | `google-provider-suite/antigravity/` |
| `src/plugin/gemini-cli/` | `google-provider-suite/gemini-cli/` |
| Google API Key handling in Account | `google-provider-suite/google-api/` |
| Dialog components for Google | `google-provider-suite/admin/` |

---

# Part 2: Core Account & Admin System

## Branch Comparison Summary

### origin/dev (Upstream)
- **Auth storage**: Flat `auth.json` file at `~/.local/share/opencode/auth.json`
- **Single account per provider**: No multi-account support
- **No Admin TUI**: Only basic `/provider` command for adding credentials
- **Simple API**: `Auth.get()`, `Auth.set()`, `Auth.remove()`, `Auth.all()`

### cms Branch (Current)
- **Account module**: Structured `accounts.json` with multi-account support
- **Provider families**: `google`, `openai`, `anthropic`, `antigravity`, `gemini-cli`, `gitlab`
- **Admin TUI**: Full `/admin` command with account/model management
- **Auth wrapper**: `Auth` module wraps `Account` module for backward compatibility
- **Migration logic**: Auto-migrates from `auth.json`, `antigravity-accounts.json`, etc.

## TUI Command Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TUI Command Mapping                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  origin/dev 原生:                                                        │
│  ┌──────────────┐    ┌──────────────┐                                   │
│  │  /models     │    │  /provider   │                                   │
│  │ (model選擇)  │    │ (認證新增)   │                                   │
│  └──────────────┘    └──────────────┘                                   │
│         │                   │                                            │
│         └───────┬───────────┘                                            │
│                 │ 整合                                                   │
│                 ▼                                                        │
│  cms 新增:                                                              │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                        /admin                                   │     │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐ │     │
│  │  │ Favorites  │  │ Recents    │  │ Providers  │  │ Models   │ │     │
│  │  │ (快捷模型) │  │ (最近使用) │  │ (多帳號)   │  │ (完整列) │ │     │
│  │  └────────────┘  └────────────┘  └────────────┘  └──────────┘ │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  遺留/刪除:                                                             │
│  ┌──────────────┐                                                       │
│  │  /accounts   │  ← 刪除 (功能已整合到 /admin)                         │
│  └──────────────┘                                                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**設計原則**:
- `/models` - origin/dev 原生，**保持不變**
- `/provider` - origin/dev 原生，**保持不變**
- `/admin` - cms 新增，整合所有管理功能
- `/accounts` - **刪除**（遺留產物，功能已整合到 /admin）

---

## Plugin Architecture

### Layer 1: Core Account Plugin (`@opencode/account-manager`)

**Purpose**: Provides multi-account credential management as standalone module.

**Files to extract**:
```
src/plugin/account-manager/
├── index.ts           # Plugin entry point
├── account.ts         # Account namespace (from src/account/index.ts)
├── storage.ts         # JSON file operations
├── migration.ts       # Migration logic for auth.json, etc.
└── types.ts           # Zod schemas
```

**Plugin Hooks**:
```typescript
export async function AccountManagerPlugin({ client }: PluginInput): Promise<Hooks> {
  return {
    // Override auth resolution
    "auth.resolve": async (providerID: string) => {
      return Account.getActiveInfo(parseFamily(providerID))
    },

    // Expose account management API
    "account.list": async (family: string) => Account.list(family),
    "account.add": async (family, id, info) => Account.add(family, id, info),
    "account.remove": async (family, id) => Account.remove(family, id),
    "account.setActive": async (family, id) => Account.setActive(family, id),
  }
}
```

**Compatibility Strategy**:
- When plugin is NOT installed: origin/dev uses native `auth.json` logic
- When plugin IS installed: Auth module delegates to Account module
- First run with plugin: Auto-migrates `auth.json` → `accounts.json`

---

### Layer 2: Admin TUI Plugin (`@opencode/admin-tui`)

**Purpose**: Provides `/admin` command and account management UI.

**Dependencies**: `@opencode/account-manager`

**Files to extract**:
```
src/plugin/admin-tui/
├── index.ts                    # Plugin entry + command registration
├── cli/admin.ts                # CLI command handler
├── tui/
│   ├── dialog-admin.tsx        # Main admin panel (整合 providers + models)
│   ├── dialog-model-probe.tsx  # Model availability check
│   └── util/
│       └── model-probe.ts      # Probe logic
```

**Note**: `dialog-account.tsx` 和 `/accounts` 命令是遺留產物，不再需要。
所有帳號管理功能已整合到 `dialog-admin.tsx`。

**Command Registration**:
```typescript
export async function AdminTUIPlugin({ client }: PluginInput): Promise<Hooks> {
  return {
    "cli.command": {
      name: "admin",
      aliases: ["adm"],
      describe: "Launch Admin Control Panel",
      handler: async () => {
        await launchAdminTUI()
      }
    }
  }
}
```

---

### Layer 3: Auth Adapter (Bridge Layer)

**Location**: Modify `src/auth/index.ts` to support optional delegation.

```typescript
// src/auth/index.ts
export namespace Auth {
  // Check if account-manager plugin is available
  const hasAccountPlugin = async () => {
    try {
      const { Plugin } = await import("../plugin")
      const hooks = await Plugin.list()
      return hooks.some(h => h["account.list"])
    } catch {
      return false
    }
  }

  export async function get(providerID: string): Promise<Info | undefined> {
    // Try plugin first
    if (await hasAccountPlugin()) {
      const { Plugin } = await import("../plugin")
      const hooks = await Plugin.list()
      for (const hook of hooks) {
        if (hook["auth.resolve"]) {
          const result = await hook["auth.resolve"](providerID)
          if (result) return accountToAuth(result)
        }
      }
    }

    // Fallback to native auth.json (origin/dev behavior)
    return nativeGet(providerID)
  }

  // Original origin/dev implementation
  async function nativeGet(providerID: string): Promise<Info | undefined> {
    const file = Bun.file(filepath)
    const data = await file.json().catch(() => ({}))
    return data[providerID]
  }
}
```

---

## File Mapping

| cms Path | Plugin Target | Note |
|----------|---------------|------|
| `src/account/index.ts` | `@opencode/account-manager/account.ts` | 核心帳號管理 |
| `src/cli/cmd/admin.ts` | `@opencode/admin-tui/cli/admin.ts` | CLI 入口 |
| `src/cli/cmd/tui/component/dialog-admin.tsx` | `@opencode/admin-tui/tui/dialog-admin.tsx` | 主面板 |
| `src/cli/cmd/tui/component/dialog-model-probe.tsx` | `@opencode/admin-tui/tui/dialog-model-probe.tsx` | Model 探測 |
| `src/cli/cmd/tui/util/model-probe.ts` | `@opencode/admin-tui/tui/util/model-probe.ts` | 探測邏輯 |
| `src/server/routes/account.ts` | `@opencode/account-manager/routes.ts` | REST API |
| `src/cli/cmd/accounts.tsx` | ❌ 刪除 | 遺留產物 |
| `src/cli/cmd/tui/component/dialog-account.tsx` | ❌ 刪除 | 已整合到 dialog-admin |

---

## Installation & Usage

### For Users
```bash
# Install account management (required for /admin)
opencode plugin install @opencode/account-manager

# Install admin TUI (optional)
opencode plugin install @opencode/admin-tui

# Or install both as a bundle
opencode plugin install @opencode/admin-suite
```

### For Developers
```typescript
// opencode.config.ts
export default {
  plugins: [
    "@opencode/account-manager",
    "@opencode/admin-tui",
  ]
}
```

---

## Migration Path

### Phase 1: Extract to Internal Plugin (No Breaking Changes)
1. Move `src/account/index.ts` → `src/plugin/account-manager/account.ts`
2. Move admin TUI components → `src/plugin/admin-tui/`
3. Keep as `INTERNAL_PLUGINS` (directly imported, not npm)
4. Auth module uses conditional delegation

### Phase 2: Publish as External Plugin
1. Create separate npm packages
2. Remove from `INTERNAL_PLUGINS`
3. Add to `BUILTIN` array (auto-installed)
4. Users can opt-out by disabling default plugins

### Phase 3: Make Fully Optional
1. Remove from `BUILTIN`
2. Document manual installation
3. origin/dev remains clean, cms features are additive

---

## API Surface

### Account Manager Plugin API

```typescript
interface AccountManagerHooks {
  // Core CRUD
  "account.list": (family: string) => Promise<Record<string, Info>>
  "account.listAll": () => Promise<Record<string, FamilyData>>
  "account.add": (family: string, id: string, info: Info) => Promise<void>
  "account.remove": (family: string, id: string) => Promise<void>
  "account.get": (family: string, id: string) => Promise<Info | undefined>

  // Active account management
  "account.setActive": (family: string, id: string) => Promise<void>
  "account.getActive": (family: string) => Promise<string | undefined>
  "account.getActiveInfo": (family: string) => Promise<Info | undefined>

  // Auth integration
  "auth.resolve": (providerID: string) => Promise<Info | undefined>
}
```

### Admin TUI Plugin API

```typescript
interface AdminTUIHooks {
  // Command registration
  "cli.command": CommandDefinition

  // UI hooks for extensibility
  "admin.menu.provider": (family: string) => MenuOption[]
  "admin.menu.account": (family: string, accountId: string) => MenuOption[]
}
```

---

## Benefits

1. **Clean Separation**: origin/dev stays simple, cms features are additive
2. **Optional Installation**: Users who don't need multi-account can skip
3. **Easier Merging**: Less conflict when syncing with upstream
4. **Testability**: Each plugin can be tested independently
5. **Composability**: Other plugins can extend admin functionality

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Plugin API changes break admin | Version pin plugins, semantic versioning |
| Migration data loss | Backup `auth.json` before migration, reversible migration |
| Performance overhead | Lazy-load plugins, cache resolved auth |
| Circular dependencies | Strict layer boundaries, dynamic imports |

---

## Implementation Order

### Phase A: Google Provider Suite
1. [ ] Create `src/plugin/google-provider-suite/` structure
2. [ ] Move `antigravity/` into plugin with minimal changes
3. [ ] Move `gemini-cli/` into plugin with minimal changes
4. [ ] Create `google-api/` provider for API Key accounts
5. [ ] Create unified `GoogleAccountStore` in `shared/account-store.ts`
6. [ ] Create unified admin UI `admin/google-accounts.tsx`
7. [ ] Implement cross-provider rate limit fallback logic
8. [ ] Test: fresh install, migration, rate limit rotation

### Phase B: Core Account Manager
9. [ ] Create `src/plugin/account-manager/` structure
10. [ ] Extract Account namespace with minimal changes
11. [ ] Add plugin hooks to Account module
12. [ ] Modify Auth module for conditional delegation

### Phase C: Admin TUI
13. [ ] Create `src/plugin/admin-tui/` structure
14. [ ] Extract admin TUI components
15. [ ] Register `/admin` command via plugin hook
16. [ ] Integrate Google Provider Suite into admin panel

### Phase D: Testing & Documentation
17. [ ] Test with fresh install (no accounts.json)
18. [ ] Test migration from auth.json
19. [ ] Test multi-account rotation
20. [ ] Document plugin installation

---

## Plugin Dependency Graph

```
                    ┌─────────────────────────┐
                    │   @opencode/admin-tui   │
                    │      (/admin TUI)       │
                    └───────────┬─────────────┘
                                │ depends on
                    ┌───────────┴─────────────┐
                    │                         │
        ┌───────────▼───────────┐   ┌────────▼────────────────┐
        │ @opencode/account-    │   │ @opencode/google-       │
        │       manager         │   │   provider-suite        │
        │ (multi-account core)  │   │ (api + cli + antigrav)  │
        └───────────┬───────────┘   └────────┬────────────────┘
                    │                        │
                    └──────────┬─────────────┘
                               │ both use
                    ┌──────────▼──────────────┐
                    │     origin/dev Auth     │
                    │  (auth.json fallback)   │
                    └─────────────────────────┘
```

---

## Conclusion

This design allows the cms admin system to coexist with origin/dev cleanly. The plugin architecture ensures:
- **Backward compatibility**: origin/dev behavior unchanged without plugins
- **Forward compatibility**: New features added via plugins, not core changes
- **Maintainability**: Clear separation of concerns
- **Flexibility**: Users/deployments can choose their feature set
