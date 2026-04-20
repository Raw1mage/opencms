import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Tweaks } from "../../src/config/tweaks"
import { Log } from "../../src/util/log"
import { Flag } from "../../src/flag/flag"

const projectRoot = path.join(__dirname, "../..")
const TWEAKS_ENV = "OPENCODE_TWEAKS_PATH"

let tmpDir: string
let prevEnv: string | undefined

Log.init({ print: false })

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "frontend-tweaks-route-test-"))
  prevEnv = process.env[TWEAKS_ENV]
  Tweaks.resetForTesting()
})

afterEach(() => {
  Tweaks.resetForTesting()
  if (prevEnv === undefined) delete process.env[TWEAKS_ENV]
  else process.env[TWEAKS_ENV] = prevEnv
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeTweaks(body: string): string {
  const p = path.join(tmpDir, "tweaks.cfg")
  writeFileSync(p, body, "utf8")
  process.env[TWEAKS_ENV] = p
  return p
}

describe("GET /config/tweaks/frontend", () => {
  test("returns defaults when tweaks.cfg missing", async () => {
    process.env[TWEAKS_ENV] = path.join(tmpDir, "nonexistent.cfg")
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const response = await app.request(`/config/tweaks/frontend`)
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        expect(response.status).toBe(200)
        const body = await response.json() as Record<string, unknown>
        expect(body["frontend_session_lazyload"]).toBe(0)
        expect(body["part_inline_cap_kb"]).toBe(64)
        expect(body["tail_window_kb"]).toBe(64)
        expect(body["fold_preview_lines"]).toBe(20)
        expect(body["initial_page_size_small"]).toBe("all")
        expect(body["initial_page_size_medium"]).toBe(100)
        expect(body["initial_page_size_large"]).toBe(50)
        expect(body["session_size_threshold_kb"]).toBe(512)
        expect(body["session_size_threshold_parts"]).toBe(80)
      },
    })
  })

  test("reflects user overrides from tweaks.cfg", async () => {
    writeTweaks(
      [
        "frontend_session_lazyload=1",
        "part_inline_cap_kb=128",
        "tail_window_kb=32",
        "initial_page_size_small=25",
      ].join("\n"),
    )
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const response = await app.request(`/config/tweaks/frontend`)
        if (Flag.OPENCODE_SERVER_PASSWORD) return
        expect(response.status).toBe(200)
        const body = await response.json() as Record<string, unknown>
        expect(body["frontend_session_lazyload"]).toBe(1)
        expect(body["part_inline_cap_kb"]).toBe(128)
        expect(body["tail_window_kb"]).toBe(32)
        expect(body["initial_page_size_small"]).toBe(25)
      },
    })
  })

  // session-ui-freshness Phase 2 task 2.7
  test("session-ui-freshness defaults appear in response when tweaks.cfg missing", async () => {
    process.env[TWEAKS_ENV] = path.join(tmpDir, "nonexistent.cfg")
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const response = await app.request(`/config/tweaks/frontend`)
        if (Flag.OPENCODE_SERVER_PASSWORD) return
        expect(response.status).toBe(200)
        const body = (await response.json()) as Record<string, unknown>
        expect(body["ui_session_freshness_enabled"]).toBe(0)
        expect(body["ui_freshness_threshold_sec"]).toBe(15)
        expect(body["ui_freshness_hard_timeout_sec"]).toBe(60)
      },
    })
  })

  test("session-ui-freshness overrides surface through the endpoint", async () => {
    writeTweaks(
      [
        "ui_session_freshness_enabled=1",
        "ui_freshness_threshold_sec=20",
        "ui_freshness_hard_timeout_sec=90",
      ].join("\n"),
    )
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const response = await app.request(`/config/tweaks/frontend`)
        if (Flag.OPENCODE_SERVER_PASSWORD) return
        expect(response.status).toBe(200)
        const body = (await response.json()) as Record<string, unknown>
        expect(body["ui_session_freshness_enabled"]).toBe(1)
        expect(body["ui_freshness_threshold_sec"]).toBe(20)
        expect(body["ui_freshness_hard_timeout_sec"]).toBe(90)
      },
    })
  })
})
