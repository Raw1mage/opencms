#!/usr/bin/env bun
/**
 * Live header capture — Task 4.8 evidence for
 * specs/claude-provider-beta-fingerprint-realign/.
 *
 * Reproduces the EXACT call chain inside ClaudeCodeLanguageModel.doStream so
 * the wire-bytes of `anthropic-beta` are observed end-to-end without a real
 * HTTP send. Compares against the matching test vector.
 */
import { buildHeaders } from "../packages/opencode-claude-provider/src/headers.ts"

const opts = {
  // Realistic placeholder; not validated against server
  accessToken: "REDACTED",
  modelId: "claude-opus-4-7",
  isOAuth: true,
  orgID: "00000000-0000-0000-0000-000000000000",
  billingContent: "hello world",
  fastMode: false,
  effort: false,
  taskBudget: false,
  envBetas: process.env.ANTHROPIC_BETAS
    ? process.env.ANTHROPIC_BETAS.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined,
  // Production-equivalent posture (DD-4, DD-16, DD-17)
  provider: "firstParty" as const,
  isInteractive: false,
  showThinkingSummaries: false,
  disableExperimentalBetas: !!process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
  disableInterleavedThinking: !!process.env.DISABLE_INTERLEAVED_THINKING,
}

const headers = buildHeaders(opts)
const wireBeta = headers.get("anthropic-beta")
const wireUA = headers.get("User-Agent")
const wireApiVer = headers.get("anthropic-version")

const expected = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "context-1m-2025-08-07",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
].join(",")

console.log("=== captured wire bytes (production-equivalent) ===")
console.log(`User-Agent       : ${wireUA}`)
console.log(`anthropic-version: ${wireApiVer}`)
console.log(`anthropic-beta   : ${wireBeta}`)
console.log("")
console.log("=== expected (test-vector: opencode-default) ===")
console.log(`anthropic-beta   : ${expected}`)
console.log("")
const match = wireBeta === expected
console.log(`MATCH: ${match ? "✅ byte-equivalent" : "❌ DIVERGED"}`)
process.exit(match ? 0 : 1)
