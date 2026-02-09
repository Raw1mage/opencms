#!/usr/bin/env bun
/**
 * E2E test with request body dump for comparison
 */

import { readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText } from "ai"

async function main() {
  console.log("=== E2E SDK Test with Dump ===\n")

  // Load auth
  const authPath = join(homedir(), ".config/opencode/accounts.json")
  const data = JSON.parse(readFileSync(authPath, "utf-8"))
  const account = data.families?.["claude-cli"]?.accounts?.["claude-cli-subscription-claude-cli"]

  if (!account?.accessToken) {
    console.error("✗ No subscription auth found")
    return
  }

  console.log("✓ Auth loaded")

  // Create custom fetch that dumps request
  const dumpingFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()

    if (url.includes("anthropic.com") && init?.body) {
      const debugPath = `/tmp/e2e-request-${Date.now()}.json`
      writeFileSync(debugPath, init.body as string)
      console.log(`Request dumped to: ${debugPath}`)
    }

    // Add auth headers
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${account.accessToken}`)
    headers.set("anthropic-version", "2023-06-01")
    headers.set("anthropic-beta", "oauth-2025-04-20,claude-code-20250219")

    // Modify URL to add ?beta=true
    let finalUrl = url
    if (url.includes("/v1/messages") && !url.includes("beta=true")) {
      finalUrl = url + (url.includes("?") ? "&" : "?") + "beta=true"
    }

    return fetch(finalUrl, { ...init, headers })
  }

  const anthropic = createAnthropic({
    apiKey: "dummy",
    fetch: dumpingFetch as any,
  })

  console.log("\n--- Test: Haiku ---")
  try {
    const result = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      maxTokens: 50,
      prompt: "Say hello",
    })
    console.log(`✓ SUCCESS:`, result.text.slice(0, 60))
  } catch (e: any) {
    console.log(`✗ FAILED:`, e.message.slice(0, 200))
  }
}

main().catch(console.error)
