#!/usr/bin/env bun
/**
 * Test: Plugin filtering of empty text blocks
 */

import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { AnthropicAuthPlugin } from "../src/plugin/anthropic"

async function main() {
  // Load auth
  const authPath = join(homedir(), ".config/opencode/accounts.json")
  const data = JSON.parse(readFileSync(authPath, "utf-8"))
  const account = data.families?.["claude-cli"]?.accounts?.["claude-cli-subscription-claude-cli"]

  if (!account?.accessToken) {
    console.error("✗ No subscription auth found")
    return
  }

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

  const customFetch = options.fetch as typeof fetch

  const testCases = [
    {
      name: "System with empty text block (should be filtered by plugin)",
      system: [
        { type: "text", text: "Some content" },
        { type: "text", text: "" },  // This should be filtered
      ],
    },
    {
      name: "System with whitespace-only block (should be filtered by plugin)",
      system: [
        { type: "text", text: "Some content" },
        { type: "text", text: "   " },  // This should be filtered
      ],
    },
    {
      name: "Messages with empty text block (should be filtered by plugin)",
      system: [{ type: "text", text: "You are helpful." }],
      messages: [
        { role: "user", content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "" },  // This should be filtered
        ]},
      ],
    },
  ]

  for (const testCase of testCases) {
    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      system: testCase.system,
      messages: testCase.messages || [{ role: "user", content: "Say hi" }],
      stream: true,
    })

    try {
      const response = await customFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body,
      })

      const status = response.status
      const result = status === 200 ? "OK" : "FAIL"
      console.log(`Test: ${testCase.name} - ${result} (${status})`)

      if (status !== 200) {
        const text = await response.text()
        console.log(`  Error: ${text.slice(0, 200)}`)
      }
    } catch (e: any) {
      console.log(`Test: ${testCase.name} - ERROR: ${e.message}`)
    }
  }
}

main().catch(console.error)
