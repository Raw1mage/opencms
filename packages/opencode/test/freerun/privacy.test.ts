/**
 * harness/freerun-mode — DD-11 privacy invariant.
 *
 * The ONLY network call site allowed under `packages/opencode/src/freerun/`
 * is `provider/llm-client.ts`. Every other module must be pure local
 * computation. This test scans the source tree and fails on any unauthorized
 * `fetch(` / `http.request` / `https.request` / WebSocket call.
 */

import { test, expect, describe } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import { NodeFS } from "../../src/freerun/storage/node-fs"
import { MetaFS } from "../../src/freerun/storage/meta-fs"
import { tmpdir } from "../fixture/fixture"

const FREERUN_ROOT = path.resolve(__dirname, "..", "..", "src", "freerun")
const ALLOWED_NETWORK_FILES = new Set(["provider/llm-client.ts"])

async function walkTsFiles(dir: string, relativeTo: string): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await walkTsFiles(full, relativeTo)))
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(path.relative(relativeTo, full))
    }
  }
  return out
}

describe("freerun privacy invariant (DD-11)", () => {
  test("only provider/llm-client.ts is allowed to make network calls", async () => {
    const files = await walkTsFiles(FREERUN_ROOT, FREERUN_ROOT)
    const violators: Array<{ file: string; line: number; snippet: string }> = []

    for (const rel of files) {
      if (ALLOWED_NETWORK_FILES.has(rel)) continue
      const text = await fs.readFile(path.join(FREERUN_ROOT, rel), "utf-8")
      const lines = text.split("\n")
      lines.forEach((line, idx) => {
        // Heuristics for network call patterns.
        if (
          /\bfetch\s*\(/.test(line) ||
          /\bnew\s+XMLHttpRequest\b/.test(line) ||
          /\bnew\s+WebSocket\b/.test(line) ||
          /\bhttp\.request\b/.test(line) ||
          /\bhttps\.request\b/.test(line) ||
          /\bhttp\.get\b/.test(line) ||
          /\bhttps\.get\b/.test(line) ||
          // import detections — bare 'http' / 'https' / 'undici' / 'node-fetch'
          /^\s*import\s+.*\s+from\s+["'](?:node:)?(?:http|https|undici|node-fetch)["']/.test(line) ||
          /\brequire\s*\(\s*["'](?:node:)?(?:http|https|undici|node-fetch)["']\s*\)/.test(line)
        ) {
          violators.push({ file: rel, line: idx + 1, snippet: line.trim() })
        }
      })
    }

    if (violators.length > 0) {
      const report = violators.map((v) => `  ${v.file}:${v.line}  ${v.snippet}`).join("\n")
      throw new Error(`freerun privacy invariant violated — only provider/llm-client.ts may call out.\n${report}`)
    }
    expect(violators).toEqual([])
  })

  test("storage paths derive from sessionId + dataHome only — no raw user-supplied paths", async () => {
    const nodeFs = await fs.readFile(path.join(FREERUN_ROOT, "storage", "node-fs.ts"), "utf-8")
    // Path computation must go through sessionStorageDir() / nodeFilePath() from types.ts.
    expect(nodeFs).toContain("sessionStorageDir(")
    expect(nodeFs).toContain("nodeFilePath(")
  })

  test("synthetic two-user storage roots do not share session state", async () => {
    await using alice = await tmpdir({ init: async () => {} })
    await using bob = await tmpdir({ init: async () => {} })
    const sessionId = "same-session-id"

    await NodeFS.write(sessionId, mkNode({ title: "Alice root", body: "alice-only" }), alice.path)
    await NodeFS.write(sessionId, mkNode({ title: "Bob root", body: "bob-only" }), bob.path)
    await MetaFS.write(sessionId, mkMeta({ user_id: "alice" }), alice.path)
    await MetaFS.write(sessionId, mkMeta({ user_id: "bob" }), bob.path)

    await expect(NodeFS.read(sessionId, "root", alice.path)).resolves.toMatchObject({ body: "alice-only" })
    await expect(NodeFS.read(sessionId, "root", bob.path)).resolves.toMatchObject({ body: "bob-only" })
    await expect(MetaFS.read(sessionId, alice.path)).resolves.toMatchObject({ user_id: "alice" })
    await expect(MetaFS.read(sessionId, bob.path)).resolves.toMatchObject({ user_id: "bob" })
  })
})

function mkNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "root",
    parent_id: null,
    children_ids: [],
    title: "root",
    body: "",
    mode: "pending-plan",
    created_at: "2026-06-14T00:00:00.000Z",
    iteration_count: 0,
    observations: [],
    decisions: [],
    blockers: [],
    results: null,
    next_intent: "",
    consolidated_summary: null,
    ...overrides,
  } as any
}

function mkMeta(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "same-session-id",
    trigger_mode: "goal",
    provider_id: "test-provider",
    user_id: "user",
    root_node_id: "root",
    started_at: "2026-06-14T00:00:00.000Z",
    final_status: "in_progress",
    total_iterations: 0,
    experiment_config: {},
    experiment_config_id: "test-config",
    protocol_version: "v0",
    ...overrides,
  } as any
}
