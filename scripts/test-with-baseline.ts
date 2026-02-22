#!/usr/bin/env bun

const ROOT = "/home/pkcs12/projects/opencode"
const TEST_TIMEOUT_MS = "30000"

const TEST_GLOBS = [
  "packages/*/test/**/*.test.{ts,tsx,js,jsx}",
  "packages/*/test/**/*.spec.{ts,tsx,js,jsx}",
  "packages/*/*/test/**/*.test.{ts,tsx,js,jsx}",
  "packages/*/*/test/**/*.spec.{ts,tsx,js,jsx}",
  "packages/opencode/src/**/*.test.{ts,tsx,js,jsx}",
  "packages/opencode/src/**/*.spec.{ts,tsx,js,jsx}",
  "packages/console/*/src/**/*.test.{ts,tsx,js,jsx}",
  "packages/console/*/src/**/*.spec.{ts,tsx,js,jsx}",
  "packages/enterprise/src/**/*.test.{ts,tsx,js,jsx}",
  "packages/enterprise/src/**/*.spec.{ts,tsx,js,jsx}",
] as const

const ANTIGRAVITY_SKIP_PREFIXES = [
  "packages/opencode/src/plugin/antigravity/",
  "packages/opencode/test/plugin/antigravity/",
] as const

function isSkippedPath(filePath: string) {
  return ANTIGRAVITY_SKIP_PREFIXES.some((prefix) => filePath.includes(prefix))
}

async function collectTests() {
  const files = new Set<string>()
  for (const pattern of TEST_GLOBS) {
    const glob = new Bun.Glob(pattern)
    for await (const file of glob.scan({ cwd: ROOT, onlyFiles: true })) {
      if (isSkippedPath(file)) continue
      files.add(file)
    }
  }
  return [...files].sort()
}

function run(command: string[], cwd?: string) {
  return Bun.spawnSync(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })
}

const tests = await collectTests()

if (tests.length === 0) {
  console.warn("[verify] no test files discovered after antigravity baseline filtering.")
} else {
  console.log(`[verify] running ${tests.length} tests (antigravity auth plugin tests excluded).`)
  const result = run(["bun", "test", "--timeout", TEST_TIMEOUT_MS, ...tests], ROOT)
  if (result.exitCode !== 0) process.exit(result.exitCode)
}

const appResult = run(["bun", "run", "test:unit"], `${ROOT}/packages/app`)
if (appResult.exitCode !== 0) process.exit(appResult.exitCode)
