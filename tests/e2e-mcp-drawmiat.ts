#!/usr/bin/env bun
/**
 * E2E test: daemon → MCP drawmiat → tool call → result
 *
 * Tests the exact same path the daemon uses:
 *   1. StdioClientTransport with the configured command
 *   2. Client.connect() (initialize handshake)
 *   3. client.listTools()
 *   4. client.callTool("generate_diagram", ...) with a small Grafcet
 *   5. Verify result arrives within timeout
 *   6. client.close()
 *
 * Usage: bun tests/e2e-mcp-drawmiat.ts [--timeout 10000]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"

const TIMEOUT_MS = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--timeout") ?? "10000")
const COMMAND = ["/home/pkcs12/projects/drawmiat/.venv/bin/python", "-u", "/home/pkcs12/projects/drawmiat/mcp_server.py"]

const GRAFCET_JSON = JSON.stringify([
  {
    StepNumber: 0,
    StepType: "initial",
    StepAction: "Idle",
    ModuleRef: "A0",
    LinkOutputType: "track",
    LinkInputNumber: [],
    LinkOutputNumber: [1],
    Condition: ["start"],
  },
  {
    StepNumber: 1,
    StepType: "normal",
    StepAction: "Run",
    ModuleRef: "A0",
    LinkOutputType: "track",
    LinkInputNumber: [0],
    LinkOutputNumber: [0],
    Condition: ["stop"],
  },
])

interface TestResult {
  step: string
  ok: boolean
  ms: number
  detail?: string
}

const results: TestResult[] = []

function report(step: string, ok: boolean, ms: number, detail?: string) {
  results.push({ step, ok, ms, detail })
  const icon = ok ? "✓" : "✗"
  console.log(`  ${icon} ${step} (${ms}ms)${detail ? " — " + detail : ""}`)
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

async function main() {
  console.log(`\nE2E: drawmiat MCP (timeout=${TIMEOUT_MS}ms)`)
  console.log(`  cmd: ${COMMAND.join(" ")}`)
  console.log()

  let stderrBuf = ""
  const transport = new StdioClientTransport({
    command: COMMAND[0],
    args: COMMAND.slice(1),
    stderr: "pipe",
    cwd: "/home/pkcs12/projects/drawmiat",
  })
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })

  const client = new Client({ name: "e2e-test", version: "1.0" })
  let closeFired = false
  client.onclose = () => { closeFired = true }

  // Step 1: connect
  let t0 = Date.now()
  try {
    await withTimeout(client.connect(transport), TIMEOUT_MS, "connect")
    report("connect", true, Date.now() - t0, `pid=${transport.pid}`)
  } catch (e) {
    report("connect", false, Date.now() - t0, String(e))
    if (stderrBuf) console.log("  stderr:", stderrBuf.slice(-300))
    process.exit(1)
  }

  // Step 2: listTools
  t0 = Date.now()
  let toolNames: string[] = []
  try {
    const tools = await withTimeout(client.listTools(), TIMEOUT_MS, "listTools")
    toolNames = tools.tools.map((t) => t.name)
    report("listTools", true, Date.now() - t0, toolNames.join(", "))
  } catch (e) {
    report("listTools", false, Date.now() - t0, String(e))
  }

  if (!toolNames.includes("generate_diagram")) {
    report("has generate_diagram", false, 0, `available: ${toolNames}`)
    await client.close().catch(() => {})
    process.exit(1)
  }

  // Step 3: callTool — generate_diagram (Grafcet)
  t0 = Date.now()
  try {
    const result = (await withTimeout(
      client.callTool(
        {
          name: "generate_diagram",
          arguments: {
            diagram_type: "grafcet",
            json_payload: GRAFCET_JSON,
            output_dir: "/tmp/e2e-mcp-test",
          },
        },
        CallToolResultSchema,
      ),
      TIMEOUT_MS,
      "callTool",
    )) as any

    const elapsed = Date.now() - t0
    const hasContent = Array.isArray(result.content) && result.content.length > 0
    const text = result.content?.[0]?.text?.slice(0, 120) ?? ""
    report("callTool generate_diagram", hasContent && !result.isError, elapsed, text)
  } catch (e) {
    report("callTool generate_diagram", false, Date.now() - t0, String(e))
  }

  // Step 4: callTool — validate_diagram
  t0 = Date.now()
  try {
    const result = (await withTimeout(
      client.callTool(
        {
          name: "validate_diagram",
          arguments: {
            diagram_type: "grafcet",
            json_payload: GRAFCET_JSON,
          },
        },
        CallToolResultSchema,
      ),
      TIMEOUT_MS,
      "callTool validate",
    )) as any

    const elapsed = Date.now() - t0
    const text = result.content?.[0]?.text?.slice(0, 120) ?? ""
    report("callTool validate_diagram", true, elapsed, text)
  } catch (e) {
    report("callTool validate_diagram", false, Date.now() - t0, String(e))
  }

  // Step 5: close
  t0 = Date.now()
  try {
    await withTimeout(client.close(), 5000, "close")
    report("close", true, Date.now() - t0)
  } catch (e) {
    report("close", false, Date.now() - t0, String(e))
  }

  // Summary
  const failed = results.filter((r) => !r.ok)
  console.log()
  if (failed.length === 0) {
    console.log(`✓ All ${results.length} steps passed`)
  } else {
    console.log(`✗ ${failed.length}/${results.length} steps failed:`)
    for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`)
  }

  if (stderrBuf.includes("Traceback")) {
    console.log("\n  ⚠ Server stderr had tracebacks:")
    console.log("  " + stderrBuf.slice(-400).replace(/\n/g, "\n  "))
  }

  process.exit(failed.length > 0 ? 1 : 0)
}

main()
