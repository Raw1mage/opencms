#!/usr/bin/env bun
/**
 * Direct fetch test - bypasses AI SDK completely
 * Uses plugin's custom fetch directly
 */

import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { AnthropicAuthPlugin } from "../src/plugin/anthropic"

async function main() {
  console.log("=== Direct Fetch Test (No AI SDK) ===\n")

  // 1. Load auth
  const authPath = join(homedir(), ".config/opencode/accounts.json")
  const data = JSON.parse(readFileSync(authPath, "utf-8"))
  const account = data.families?.["claude-cli"]?.accounts?.["claude-cli-subscription-claude-cli"]

  if (!account?.accessToken) {
    console.error("✗ No subscription auth found")
    return
  }
  console.log("✓ Auth loaded")

  // 2. Initialize plugin
  const mockClient = {
    auth: {
      get: async () => ({
        type: "subscription",
        access: account.accessToken,
        refresh: account.refreshToken,
        expires: account.expiresAt,
        accountId: "claude-cli-subscription-claude-cli",
      }),
      set: async () => {},
    },
  }

  const plugin = await AnthropicAuthPlugin({ client: mockClient } as any)
  const getAuth = () => mockClient.auth.get()
  const options = await plugin.auth!.loader!(getAuth, { models: {} } as any)

  if (!options?.fetch) {
    console.error("✗ No custom fetch")
    return
  }
  console.log("✓ Plugin fetch ready")

  // Wrap fetch to log actual request
  const customFetch = async (url: string, init: any) => {
    console.log("  [DEBUG] Final request:")
    console.log("    URL:", url)
    const headers = new Headers(init.headers)
    console.log("    Headers:", Array.from(headers.keys()))
    const body = JSON.parse(init.body)
    console.log("    Model:", body.model)
    console.log("    Tools:", body.tools?.map((t: any) => t.name) || "none")
    return options.fetch(url, init)
  }

  // 3. Test models
  const tests = [
    { name: "Haiku (no tools)", model: "claude-haiku-4-5", tools: false },
    { name: "Sonnet (with tools)", model: "claude-sonnet-4-5-20250929", tools: true },
    { name: "Opus (with tools)", model: "claude-opus-4-5-20251101", tools: true },
  ]

  for (const test of tests) {
    console.log(`\n--- ${test.name} ---`)

    const body: any = {
      model: test.model,
      max_tokens: 100,
      messages: [{ role: "user", content: "Say 'Hello' in 3 words." }],
      stream: false,
    }

    if (test.tools) {
      body.tools = [
        {
          name: "read_file",  // Plugin should add mcp_ prefix
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ]
    }

    try {
      const response = await customFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (response.ok) {
        const json = await response.json()
        const text = json.content?.[0]?.text || JSON.stringify(json).slice(0, 100)
        console.log(`✓ SUCCESS (${response.status}):`, text.slice(0, 80))
      } else {
        const text = await response.text()
        console.log(`✗ FAILED (${response.status}):`, text.slice(0, 150))
      }
    } catch (e: any) {
      console.log(`✗ ERROR:`, e.message)
    }
  }

  console.log("\n=== Test Complete ===")
}

main().catch(console.error)
