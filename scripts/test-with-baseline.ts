#!/usr/bin/env bun

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
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

const ANTIGRAVITY_SKIP_PREFIXES = [] as const

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
  console.warn("[verify] no test files discovered.")
} else if (process.env.OPENCODE_TEST_NO_ISOLATE === "1") {
  // Legacy single-process mode: all files share one `bun test` process. Faster,
  // but a test's mock.module / global-state mutation leaks into later files
  // (bun does not fork per file), producing false cross-file failures.
  console.log(`[verify] running ${tests.length} tests (single process).`)
  const result = run(["bun", "test", "--timeout", TEST_TIMEOUT_MS, ...tests], ROOT)
  if (result.exitCode !== 0) process.exit(result.exitCode)
} else {
  // Default: run each file in its OWN process so mock.module replacements and
  // module-level state cannot bleed across files. Bounded parallelism keeps the
  // wall-clock close to the single-process run despite per-file startup.
  const concurrency = Math.max(2, Math.min(16, (navigator.hardwareConcurrency ?? 4) - 1))
  console.log(`[verify] running ${tests.length} tests (isolated per-file, concurrency ${concurrency}).`)
  const decoder = new TextDecoder()
  const queue = [...tests]
  const failures: string[] = []
  let done = 0

  async function worker() {
    while (true) {
      const file = queue.shift()
      if (!file) return
      const proc = Bun.spawn(["bun", "test", "--timeout", TEST_TIMEOUT_MS, file], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      done++
      if (code !== 0) {
        failures.push(file)
        process.stdout.write(`\n=== FAIL (${done}/${tests.length}): ${file} ===\n${out}${err}\n`)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  if (failures.length > 0) {
    process.stdout.write(`\n[verify] ${failures.length} of ${tests.length} test files failed:\n`)
    for (const f of failures.sort()) process.stdout.write(`  ${f}\n`)
    process.exit(1)
  }
  console.log(`[verify] all ${tests.length} test files passed (isolated).`)
}

const appResult = run(["bun", "run", "test:unit"], `${ROOT}/packages/app`)
if (appResult.exitCode !== 0) process.exit(appResult.exitCode)
