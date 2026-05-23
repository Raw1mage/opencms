import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@hey-api/openapi-ts"
import { execFileSync } from "child_process"

const dir = fileURLToPath(new URL("..", import.meta.url))
const rootDir = path.resolve(dir, "../../..")
const bun = process.execPath

const openapiGenerator = path.resolve(rootDir, "packages/opencode/src/openapi/generate.ts")
execFileSync(bun, [openapiGenerator, `${dir}/openapi.json`], { cwd: rootDir, stdio: "inherit" })

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

execFileSync(bun, ["run", "--cwd", rootDir, "node_modules/.bin/prettier", "--write", "packages/sdk/js/src/gen"], {
  stdio: "inherit",
})
execFileSync(bun, ["run", "--cwd", rootDir, "node_modules/.bin/prettier", "--write", "packages/sdk/js/src/v2"], {
  stdio: "inherit",
})
execFileSync(bun, ["run", "--cwd", rootDir, "node_modules/.bin/tsc", "-p", "packages/sdk/js/tsconfig.json"], {
  stdio: "inherit",
})
