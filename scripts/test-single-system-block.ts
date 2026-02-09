#!/usr/bin/env bun
/**
 * Test: Single system block vs multiple system blocks
 * Hypothesis: Empty system[1] block causes failure
 */

import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

async function main() {
  // Load auth
  const authPath = join(homedir(), ".config/opencode/accounts.json")
  const data = JSON.parse(readFileSync(authPath, "utf-8"))
  const account = data.families?.["claude-cli"]?.accounts?.["claude-cli-subscription-claude-cli"]

  if (!account?.accessToken) {
    console.error("✗ No subscription auth found")
    return
  }

  const testCases = [
    {
      name: "Single system block (identity only)",
      system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }],
    },
    {
      name: "Two blocks: identity + content",
      system: [
        { type: "text", text: CLAUDE_CODE_IDENTITY },
        { type: "text", text: "You are helpful." },
      ],
    },
    {
      name: "Two blocks: identity + empty",
      system: [
        { type: "text", text: CLAUDE_CODE_IDENTITY },
        { type: "text", text: "" },
      ],
    },
    {
      name: "Two blocks: identity + whitespace",
      system: [
        { type: "text", text: CLAUDE_CODE_IDENTITY },
        { type: "text", text: " " },
      ],
    },
    {
      name: "String system (not array)",
      system: CLAUDE_CODE_IDENTITY,
    },
  ]

  for (const testCase of testCases) {
    const body = JSON.stringify({
      model: "claude-opus-4-5-20251101",
      max_tokens: 50,
      system: testCase.system,
      messages: [{ role: "user", content: "Say hi" }],
      stream: true,
    })

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${account.accessToken}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
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
