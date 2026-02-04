# opencode agent guidelines

## 知識紀錄

- 主要知識記錄索引為 `docs/DIARY.md`。
- 具體開發紀錄（PLANNING / DEBUGLOG / CHANGELOG）儲存於 `docs/events/event_$date.md`。
- DIARY 僅作為事件索引，記錄日期、任務摘要及指向對應 event 檔案的連結。
- 不再生成獨立的 `PLANNING.md` 或 `ARCHITECTURE.md` 檔案。
- 所有紀錄依日期排序，並以繁體中文撰寫。

## Communication Flow

- **Respond First**: Always answer the user's questions or acknowledge their request before starting any coding task.
- **Analyze & Plan**: Provide a brief analysis of the problem and your proposed plan of action.
- **Clarify & Act**: 使用多選題釐清需求。完成需求釐清與 PLANNING 後，直接更新 event 紀錄並開始實作，避免冗餘的重複確認。
- **Explain Actions**: Avoid jumping into long coding blocks (10+ minutes) without first explaining what you are about to do.
- **Language**: Use Traditional Chinese (繁體中文) for all communication with the user.

## Build/Test Commands

- **Install**: `bun install`
- **Run**: `bun run --conditions=browser ./src/index.ts`
- **Typecheck**: `bun run typecheck` (npm run typecheck)
- **Test**: `bun test` (runs all tests)
- **Single test**: `bun test test/tool/tool.test.ts` (specific test file)

## Code Style

- **Runtime**: Bun with TypeScript ESM modules
- **Imports**: Use relative imports for local modules, named imports preferred
- **Types**: Zod schemas for validation, TypeScript interfaces for structure
- **Naming**: camelCase for variables/functions, PascalCase for classes/namespaces
- **Error handling**: Use Result patterns, avoid throwing exceptions in tools
- **File structure**: Namespace-based organization (e.g., `Tool.define()`, `Session.create()`)

## Architecture

- **Tools**: Implement `Tool.Info` interface with `execute()` method
- **Context**: Pass `sessionID` in tool context, use `App.provide()` for DI
- **Validation**: All inputs validated with Zod schemas
- **Logging**: Use `Log.create({ service: "name" })` pattern
- **Storage**: Use `Storage` namespace for persistence
- **API Client**: The TypeScript TUI (built with SolidJS + OpenTUI) communicates with the OpenCode server using `@opencode-ai/sdk`. When adding/modifying server endpoints in `packages/opencode/src/server/server.ts`, run `./scripts/generate.ts` to regenerate the SDK and related files.

---

## 規劃與架構 (Planning & Architecture) - **強制執行**

在編寫 **任何** 程式碼之前，請先記錄計畫：

### 步驟 1：建立或更新 docs/events/event_$date.md

```markdown
#### 功能：<名稱>

**需求**

- <釐切後的條列重點>

**範圍**

- IN：<包含項目>
- OUT：<排除項目>

**方法**

- <高層次策略>

**任務**

1. [ ] <任務 1>
2. [ ] <任務 2>

**待解問題**

- <任何未解決項目>
```

### 步驟 2：更新 docs/DIARY.md 索引

在 `docs/DIARY.md` 中新增一條索引，連結至該 event 檔案。

### 步驟 3：驗證與實作

- 確保流程合乎邏輯且無死角。
- 需求釐清後直接實作，不需再詢問「是否開始規劃」。
