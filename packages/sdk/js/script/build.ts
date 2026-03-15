import path from "node:path"
import { fileURLToPath } from "node:url"
import { $ } from "bun"
import { createClient } from "@hey-api/openapi-ts"
import { execSync } from "child_process"

const dir = fileURLToPath(new URL("..", import.meta.url))

const opencodeDir = path.resolve(dir, "../../opencode")
execSync(`bun run ./src/openapi/generate.ts ${dir}/openapi.json`, { cwd: opencodeDir, stdio: "inherit" });

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`bun tsc`
