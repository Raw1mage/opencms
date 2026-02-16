# Refactoring Plan: 2026-02-10 (Focused on CLI/TUI Core)

## Executive Summary

- **Total Commits in origin/dev**: 521
- **Relevant to cms (CLI/TUI core)**: 191 (36.7%)
- **Strategy**: 選擇性 Cherry-pick，聚焦於 `src/` 核心邏輯
- **Skip**: Web UI (app), Desktop App, Console, Website (330 commits)

## CMS 分支特性與保護區域

### CMS 獨特架構（絕不直接 merge）

- `src/provider/` - 三分化 Provider (antigravity, gemini-cli, google-api)
- `src/account/` - 多帳號管理系統
- `src/session/llm.ts` - Rotation3D 模型輪替系統
- `src/cli/cmd/admin.ts` - Admin Panel 入口
- `src/cli/cmd/tui/` - TUI 元件（可能有客製化）

### CMS 使用場景

- ✅ CLI/TUI 介面
- ✅ Admin Panel (`/admin`)
- ❌ Web UI (未使用)
- ❌ Desktop App (未使用)

## Phase 1: 核心 Provider & Session 修復 (Priority: CRITICAL)

這些 commits 修復核心邏輯 bug，必須引進：

| Commit      | Subject                                    | Action         |
| ----------- | ------------------------------------------ | -------------- |
| `99ea1351c` | tweak: add new ContextOverflowError type   | ✅ Cherry-pick |
| `0cd52f830` | fix: enable thinking for alibaba-cn        | ✅ Cherry-pick |
| `62f38087b` | fix: parse mid stream openai responses     | ✅ Cherry-pick |
| `fde0b39b7` | fix: properly encode file URLs             | ✅ Cherry-pick |
| `def907ae4` | fix: SessionPrompt.shell() triggers loop   | ✅ Cherry-pick |
| `18749c1f4` | fix: correct prefix for amazon-bedrock     | ✅ Cherry-pick |
| `24dbc4654` | fix(github): handle step-start/step-finish | ✅ Cherry-pick |
| `72de9fe7a` | fix: image reading with OpenAI-compatible  | ✅ Cherry-pick |
| `305007aa0` | fix: cloudflare workers ai provider        | ✅ Cherry-pick |
| `d1686661c` | fix: kimi k2p5 thinking on by default      | ✅ Cherry-pick |

**小計**: 10 commits

## Phase 2: Skill 系統增強 (Priority: HIGH)

| Commit      | Subject                                            | Action                |
| ----------- | -------------------------------------------------- | --------------------- |
| `7249b87bf` | feat: skill discovery from URLs via well-known RFC | ✅ Cherry-pick        |
| `266de27a0` | feat: skill discovery from URLs (duplicate?)       | 🔍 Check if duplicate |
| `c35bd3982` | tui: parallelize skill downloads                   | ✅ Cherry-pick        |
| `17e62b050` | feat: read skills from .agents/skills              | ✅ Cherry-pick        |
| `397532962` | feat: improve skills prompting & permissions       | ✅ Cherry-pick        |
| `a68fedd4a` | chore: adjust skill dirs whitelist                 | ✅ Cherry-pick        |

**小計**: 5-6 commits

## Phase 3: Plugin 系統改進 (Priority: HIGH)

| Commit      | Subject                                    | Action         |
| ----------- | ------------------------------------------ | -------------- |
| `53298145a` | fix: add directory param for multi-project | ✅ Cherry-pick |
| `83156e515` | chore(deps): bump gitlab ai provider       | ✅ Cherry-pick |
| `9adcf524e` | core: bundle GitLab auth plugin            | ✅ Cherry-pick |
| `a1c46e05e` | core: fix plugin installation              | ✅ Cherry-pick |
| `1824db13c` | tweak: load user plugins after builtin     | ✅ Cherry-pick |
| `09a0e921c` | fix: user plugins override built-in        | ✅ Cherry-pick |
| `3577d829c` | fix: allow user plugins to override auth   | ✅ Cherry-pick |
| `556adad67` | fix: wait for dependencies before loading  | ✅ Cherry-pick |

**小計**: 8 commits

## Phase 4: Config & CLI 改進 (Priority: MEDIUM)

| Commit      | Subject                                    | Action         |
| ----------- | ------------------------------------------ | -------------- |
| `576a681a4` | feat: add models.dev schema ref            | ✅ Cherry-pick |
| `229cdafcc` | fix(config): handle $ character            | ✅ Cherry-pick |
| `7c748ef08` | core: silently ignore proxy failures       | ✅ Cherry-pick |
| `0d38e6903` | fix: skip dependency install in read-only  | ✅ Cherry-pick |
| `89064c34c` | fix: cleanup orphaned worktree directories | ✅ Cherry-pick |
| `84c5df19c` | feat(tui): add --fork flag                 | ✅ Cherry-pick |
| `ee84eb44e` | cli: add --thinking flag                   | ✅ Cherry-pick |
| `a45841396` | core: fix unhandled errors when aborting   | ✅ Cherry-pick |

**小計**: 8 commits

## Phase 5: 需手動 Port 的高風險項目 (Priority: MEDIUM)

這些涉及 session/llm 邏輯，可能與 rotation3d 衝突：

| Commit      | Subject                                    | Action                |
| ----------- | ------------------------------------------ | --------------------- |
| `8ad4768ec` | tweak: adjust agent variant logic          | 🔧 Manual Port + Test |
| `a486b74b1` | feat: Set variant in assistant messages    | 🔧 Manual Port + Test |
| `a25cd2da7` | feat: use reasoning summary auto for gpt-5 | 🔧 Manual Port + Test |
| `f15755684` | fix: scope agent variant to model          | 🔧 Manual Port + Test |
| `d52ee41b3` | fix: variant logic for anthropic           | 🔧 Manual Port + Test |

**小計**: 5 commits (需驗證與 rotation3d 兼容性)

## Phase 6: Provider 特定修復 (Priority: LOW-MEDIUM)

按 Provider 分類：

### Amazon Bedrock

- `b942e0b4d` - fix: prevent double-prefixing

### Anthropic/Claude

- `ca5e85d6e` - fix: prompt caching for opus on bedrock
- `d1d744749` - fix: switching anthropic models mid convo

### Copilot

- `43354eeab` - fix: convert system message to string
- `d9f18e400` - feat: add copilot specific provider

### Gemini/Google

- `3741516fe` - fix: handle nested array for schema
- `3adeed8f9` - fix: strip properties from non-object

### OpenAI

- `bd9d7b322` - fix: session title generation
- `39a504773` - fix: provider headers from config not applied
- `0c32afbc3` - fix: use snake_case for thinking param

**小計**: 約 10 commits

## Phase 7: TUI 元件更新 (Priority: LOW)

⚠️ 注意：cms 可能有 TUI 客製化，需逐一檢視

| Commit      | Subject                                     | Action                              |
| ----------- | ------------------------------------------- | ----------------------------------- |
| `683d234d8` | feat(tui): highlight esc label on hover     | 🔍 Review first                     |
| `449c5b44b` | feat(tui): restore footer to session view   | 🔍 Review (可能與 Admin Panel 衝突) |
| `40ebc3490` | feat(tui): add running spinner to bash tool | 🔍 Review                           |

**小計**: 3 commits (需審查)

## 明確排除項目 (SKIP)

以下 **330 commits** 對 cms 無價值，完全跳過：

### UI/Frontend (約 200 commits)

- `packages/app/` - Web UI 元件
- `packages/desktop/` - Desktop App
- `packages/web/` - 官網
- `packages/console/` - Console

### Infrastructure (約 80 commits)

- `.github/workflows/` - CI/CD
- `nix/` - Nix builds
- E2E tests for app/desktop

### i18n & Docs (約 50 commits)

- 多語系翻譯
- README 翻譯
- 官網文件

## Execution Strategy

### 建議採用分階段執行

#### Stage 1: Quick Wins (1-2 小時)

執行 Phase 1-4，約 **31 個 commits**，都是低風險的 bug fixes

```bash
# Phase 1: 核心修復
git cherry-pick 99ea1351c 0cd52f830 62f38087b fde0b39b7 def907ae4 \
                18749c1f4 24dbc4654 72de9fe7a 305007aa0 d1686661c

# Phase 2: Skill 系統
git cherry-pick 7249b87bf c35bd3982 17e62b050 397532962 a68fedd4a

# Phase 3: Plugin 系統
git cherry-pick 53298145a 83156e515 9adcf524e a1c46e05e 1824db13c \
                09a0e921c 3577d829c 556adad67

# Phase 4: Config & CLI
git cherry-pick 576a681a4 229cdafcc 7c748ef08 0d38e6903 89064c34c \
                84c5df19c ee84eb44e a45841396
```

#### Stage 2: Manual Port (2-3 小時)

Phase 5 的 5 個 commits 需要：

1. 讀取 origin/dev 的變更
2. 理解邏輯
3. 適配到 cms 的 rotation3d 架構
4. 測試模型切換是否正常

#### Stage 3: Provider Fixes (1 小時)

Phase 6 按需引進，可選擇性執行

#### Stage 4: TUI Review (Optional)

Phase 7 需先確認 cms 的 TUI 客製化範圍

### Risk Mitigation

1. **每個 Phase 執行後都測試**

   ```bash
   bun test
   bun run src/cli/index.ts  # 測試 CLI 啟動
   ```

2. **驗證 rotation3d**
   - 測試多模型輪替
   - 測試 variant 選擇邏輯

3. **驗證多帳號系統**
   - 確保帳號切換正常
   - 確保 Provider 隔離正常

## Timeline Estimate

- **Stage 1 (Quick Wins)**: 1-2 小時
- **Stage 2 (Manual Port)**: 2-3 小時
- **Stage 3 (Provider)**: 1 小時
- **Stage 4 (TUI Review)**: 1 小時
- **Total**: 5-7 小時

## Success Metrics

- [ ] 所有核心測試通過
- [ ] Rotation3D 運作正常
- [ ] 多帳號切換無誤
- [ ] Admin Panel 正常啟動
- [ ] 無 regression bugs

## Notes

- 本次預計引進 **45-50 個有價值的 commits** (佔總數的 8.6%)
- 跳過 **471 個無關 commits** (UI/Desktop/Docs/CI)
- 重點在 `src/` 核心邏輯，完全不動 Web/Desktop UI
