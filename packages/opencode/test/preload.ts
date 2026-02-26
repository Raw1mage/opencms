// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import { createRequire } from "node:module"
import { afterAll, vi } from "bun:test"

const require = createRequire(import.meta.url)

const dir = path.join(os.tmpdir(), "opencode-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(async () => {
  const busy = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"

  const rm = async (left: number): Promise<void> => {
    Bun.gc(true)
    await Bun.sleep(100)
    return fs.rm(dir, { recursive: true, force: true }).catch((error) => {
      if (!busy(error)) throw error
      if (left <= 1) throw error
      return rm(left - 1)
    })
  }

  await rm(30)
})
// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["OPENCODE_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
const oauthPortState = { value: 0 }
for (const _ of Array.from({ length: 20 })) {
  const candidate = 20000 + Math.floor(Math.random() * 20000)
  try {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: candidate,
      fetch() {
        return new Response("ok")
      },
    })
    oauthPortState.value = candidate
    server.stop(true)
    break
  } catch {
    continue
  }
}
if (!oauthPortState.value) {
  oauthPortState.value = 29876
}
process.env["OPENCODE_OAUTH_CALLBACK_PORT"] = String(oauthPortState.value)
process.env["OPENCODE_TEST_LSP_SKIP_INIT"] = "1"
process.env["OPENCODE_TEST_NO_ACCOUNT_CACHE"] = "1"

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "cache", "opencode")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

// Clear provider env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]

const v = vi as any
;(globalThis as any).vi = v
if (v && typeof v.stubGlobal !== "function") {
  v.stubGlobal = (name: string, value: unknown) => {
    ;(globalThis as any)[name] = value
  }
}
if (v && typeof v.setSystemTime !== "function") {
  v.setSystemTime = (value: number | string | Date) => {
    const time = typeof value === "number" ? value : new Date(value).valueOf()
    v.useFakeTimers({ now: time })
  }
}
if (v && typeof v.advanceTimersByTimeAsync !== "function") {
  v.advanceTimersByTimeAsync = async (ms: number) => {
    v.advanceTimersByTime(ms)
    await Promise.resolve()
  }
}
if (v && typeof v.runAllTimersAsync !== "function") {
  v.runAllTimersAsync = async () => {
    v.runAllTimers()
    await Promise.resolve()
  }
}
if (v && typeof v.mocked !== "function") {
  v.mocked = <T>(item: T) => item
}
if (v && typeof v.resetModules !== "function") {
  v.resetModules = () => {}
}
if (v && typeof v.importActual !== "function") {
  v.importActual = async (id: string) => require(id)
}

// Now safe to import from src/
const { Log } = await import("../src/util/log")

Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})
