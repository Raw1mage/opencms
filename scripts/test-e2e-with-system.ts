#!/usr/bin/env bun
/**
 * E2E test WITH system prompt to match TUI behavior
 */

import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { AnthropicAuthPlugin } from "../src/plugin/anthropic"
import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText } from "ai"

async function main() {
  console.log("=== E2E Test WITH System Prompt ===\n")

  // Load auth
  const authPath = join(homedir(), ".config/opencode/accounts.json")
  const data = JSON.parse(readFileSync(authPath, "utf-8"))
  const account = data.families?.["claude-cli"]?.accounts?.["claude-cli-subscription-claude-cli"]

  if (!account?.accessToken) {
    console.error("✗ No subscription auth found")
    return
  }

  // Initialize plugin (same as TUI)
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
  const mockProvider = { models: {} }
  const options = await plugin.auth!.loader!(getAuth, mockProvider as any)

  const anthropic = createAnthropic({
    apiKey: "dummy",
    fetch: options.fetch as any,
  })

  // Test 1: Simple prompt (no system) - this should work
  console.log("--- Test 1: Simple prompt (no system) ---")
  try {
    const result = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      maxTokens: 50,
      prompt: "Say hello",
    })
    console.log(`✓ SUCCESS:`, result.text.slice(0, 60))
  } catch (e: any) {
    console.log(`✗ FAILED:`, e.message.slice(0, 150))
  }

  // Test 2: With system prompt (like TUI)
  console.log("\n--- Test 2: With system prompt ---")
  try {
    const result = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      maxTokens: 50,
      system: "You are a helpful assistant.",
      prompt: "Say hello",
    })
    console.log(`✓ SUCCESS:`, result.text.slice(0, 60))
  } catch (e: any) {
    console.log(`✗ FAILED:`, e.message.slice(0, 150))
  }

  // Test 3: With system prompt containing Claude Code identity
  console.log("\n--- Test 3: With Claude Code identity ---")
  try {
    const result = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      maxTokens: 50,
      system: "You are Claude Code, Anthropic's official CLI for Claude. You are helpful.",
      prompt: "Say hello",
    })
    console.log(`✓ SUCCESS:`, result.text.slice(0, 60))
  } catch (e: any) {
    console.log(`✗ FAILED:`, e.message.slice(0, 150))
  }

  // Test 4: With messages array (like TUI uses)
  console.log("\n--- Test 4: With messages array ---")
  try {
    const result = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      maxTokens: 50,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [
        { role: "user", content: "Say hello" }
      ],
    })
    console.log(`✓ SUCCESS:`, result.text.slice(0, 60))
  } catch (e: any) {
    console.log(`✗ FAILED:`, e.message.slice(0, 150))
  }

  console.log("\n=== Tests Complete ===")
}

main().catch(console.error)
