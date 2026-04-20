export * from "./client.js"

// `server.ts` imports node:child_process. Re-exporting its values from this
// barrel makes the browser bundle pull in node built-ins and fail to build
// (rollup: `"spawn" is not exported by "__vite-browser-external"`).
// Only types are re-exported here; consumers that actually need the server
// helpers should import them from "@opencode-ai/sdk/v2/server" directly.
export type { ServerOptions, TuiOptions } from "./server.js"

export { normalizeQuestionInput, normalizeSingleQuestion } from "./question-normalize.js"

// createOpencode() was previously here but it instantiated the Node-only
// server, dragging child_process into every bundle. If you need the
// "spawn a daemon + open a client" convenience, import from
// "@opencode-ai/sdk/v2/server" directly and pair it with
// "@opencode-ai/sdk/v2/client".
