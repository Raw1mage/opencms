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
      const report = violators
        .map((v) => `  ${v.file}:${v.line}  ${v.snippet}`)
        .join("\n")
      throw new Error(
        `freerun privacy invariant violated — only provider/llm-client.ts may call out.\n${report}`,
      )
    }
    expect(violators).toEqual([])
  })

  test("storage paths derive from sessionId + dataHome only — no raw user-supplied paths", async () => {
    const nodeFs = await fs.readFile(path.join(FREERUN_ROOT, "storage", "node-fs.ts"), "utf-8")
    // Path computation must go through sessionStorageDir() / nodeFilePath() from types.ts.
    expect(nodeFs).toContain("sessionStorageDir(")
    expect(nodeFs).toContain("nodeFilePath(")
  })
})
