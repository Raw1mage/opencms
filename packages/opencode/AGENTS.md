# opencode agent guidelines

## 知識紀錄

- 主要知識記錄檔為 `packages/opencode/DIARY.md`。
- DIARY 需整合 CHANGELOG / PLANNING / DEBUGLOG 章節，不再分散維護。
- 不再生成 `PLANNING.md` 檔案，規劃與需求請寫在 DIARY 的 PLANNING 章節。
- 所有開發紀錄統一改為 DIARY。
- 新增或移轉內容時，請依日期排序並以繁體中文撰寫。

## Communication Flow

- **Respond First**: Always answer the user's questions or acknowledge their request before starting any coding task.
- **Analyze & Plan**: Provide a brief analysis of the problem and your proposed plan of action.
- **Discuss**: Give the user a chance to discuss or approve the plan, especially for complex changes.
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
