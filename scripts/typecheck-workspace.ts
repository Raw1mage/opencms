import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const cleanPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin"
const bun = process.execPath

const env = {
  ...process.env,
  PATH: cleanPath,
}

function run(label: string, command: string, args: string[], cwd = rootDir) {
  console.log(`\n[typecheck] ${label}`)
  execFileSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  })
}

function runBun(label: string, args: string[], cwd = rootDir) {
  run(label, bun, args, cwd)
}

runBun("build @opencode-ai/sdk", ["run", "build"], path.join(rootDir, "packages/sdk/js"))

const tsgo = path.join(rootDir, "node_modules/.bin/tsgo")
const tsc = path.join(rootDir, "node_modules/.bin/tsc")

for (const tsconfig of [
  "packages/sdk/js/tsconfig.json",
  "packages/plugin/tsconfig.json",
  "packages/ui/tsconfig.json",
  "packages/opencode/tsconfig.json",
  "packages/app/tsconfig.json",
]) {
  runBun(`tsgo -p ${tsconfig}`, [tsgo, "-p", tsconfig, "--noEmit"])
}

runBun("tsc -p packages/util/tsconfig.json", [tsc, "-p", "packages/util/tsconfig.json", "--noEmit"])
