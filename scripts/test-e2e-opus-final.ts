#!/usr/bin/env bun
/**
 * Final E2E test for Opus model with empty block filtering
 */

import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { AnthropicAuthPlugin } from "../src/plugin/anthropic"
import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText } from "ai"

async function main() {
  console.log("=== Final E2E Test: Opus with Plugin ===\n")

  // Load auth
  const authPath = join(homedir(), ".config/opencode/accounts.json")
  const data = JSON.parse(readFileSync(authPath, "utf-8"))
  const account = data.families?.["claude-cli"]?.accounts?.["claude-cli-subscription-claude-cli"]

  if (!account?.accessToken) {
    console.error("✗ No subscription auth found")
    return
  }

  console.log("✓ Auth loaded\n")

  // Setup mock client
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

  // Test 1: Haiku (baseline)
  console.log("--- Test 1: Haiku (baseline) ---")
  try {
    const result = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      maxTokens: 50,
      prompt: "Say hello in one word",
    })
    console.log(`✓ SUCCESS:`, result.text.slice(0, 60))
  } catch (e: any) {
    console.log(`✗ FAILED:`, e.message.slice(0, 150))
  }

  // Test 2: Sonnet
  console.log("\n--- Test 2: Sonnet ---")
  try {
    const result = await generateText({
      model: anthropic("claude-sonnet-4-5-20250929"),
      maxTokens: 50,
      prompt: "Say hello in one word",
    })
    console.log(`✓ SUCCESS:`, result.text.slice(0, 60))
  } catch (e: any) {
    console.log(`✗ FAILED:`, e.message.slice(0, 150))
  }

  // Test 3: Opus
  console.log("\n--- Test 3: Opus ---")
  try {
    const result = await generateText({
      model: anthropic("claude-opus-4-5-20251101"),
      maxTokens: 50,
      prompt: "Say hello in one word",
    })
    console.log(`✓ SUCCESS:`, result.text.slice(0, 60))
  } catch (e: any) {
    console.log(`✗ FAILED:`, e.message.slice(0, 150))
  }

  // Test 4: Opus with system prompt containing empty blocks (simulates TUI)
  console.log("\n--- Test 4: Opus with system array + messages ---")
  try {
    const result = await generateText({
      model: anthropic("claude-opus-4-5-20251101"),
      maxTokens: 50,
      system: [
        { type: "text", text: "You are a helpful assistant." },
        { type: "text", text: "" }, // Empty block that should be filtered
      ],
      messages: [
        { role: "user", content: "Say hello in one word" },
      ],
    })
    console.log(`✓ SUCCESS:`, result.text.slice(0, 60))
  } catch (e: any) {
    console.log(`✗ FAILED:`, e.message.slice(0, 150))
  }

  console.log("\n=== Tests Complete ===")
}

main().catch(console.error)
