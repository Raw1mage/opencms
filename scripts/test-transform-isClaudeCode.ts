#!/usr/bin/env bun
/**
 * Unit test for isClaudeCode flag propagation in transform.ts
 * This tests the specific bug: isClaudeCode not being passed from options() to message()
 */

import { ProviderTransform } from "../src/provider/transform"
import type { Provider } from "../src/provider/provider"

// Mock model that uses @ai-sdk/anthropic
const mockModel: Provider.Model = {
  id: "claude-opus-4-5",
  name: "Claude Opus 4.5",
  providerId: "claude-cli",
  family: "claude",
  api: {
    id: "claude-opus-4-5",
    url: "https://api.anthropic.com",
    npm: "@ai-sdk/anthropic",
  },
  status: "active",
  capabilities: {
    temperature: true,
    reasoning: true,
    input: { text: true, image: true, pdf: true, audio: false, video: false },
    output: { text: true, image: false, audio: false },
    attachment: true,
    structured_output: true,
    tool_call: true,
  },
  limit: { context: 200000, output: 8192 },
  cost: { input: 0, output: 0 },
  options: {},
  variants: {},
  headers: {},
}

// Test messages with system prompt
const testMessages = [
  { role: "system" as const, content: "You are Claude Code, Anthropic's official CLI for Claude." },
  { role: "user" as const, content: "Hello" },
]

console.log("=== Test: isClaudeCode Flag Propagation ===\n")

// Test 1: Without isClaudeCode flag
console.log("Test 1: WITHOUT isClaudeCode flag")
const optionsWithout = ProviderTransform.options({
  model: mockModel,
  sessionID: "test-session",
  providerOptions: {}, // No isClaudeCode
  accountId: "test-account",
})
console.log("  options() result:", JSON.stringify(optionsWithout))
console.log("  isClaudeCode:", optionsWithout.isClaudeCode ?? "undefined")

// Test 2: With isClaudeCode flag
console.log("\nTest 2: WITH isClaudeCode flag")
const optionsWith = ProviderTransform.options({
  model: mockModel,
  sessionID: "test-session",
  providerOptions: { isClaudeCode: true }, // Has isClaudeCode
  accountId: "test-account",
})
console.log("  options() result:", JSON.stringify(optionsWith))
console.log("  isClaudeCode:", optionsWith.isClaudeCode ?? "undefined")

// Test 3: Verify message() behavior
console.log("\nTest 3: message() with isClaudeCode flag")
const transformedWith = ProviderTransform.message(testMessages as any, mockModel, optionsWith)
const hasCache1 = JSON.stringify(transformedWith).includes("cache_control")
console.log("  Has cache_control:", hasCache1)

console.log("\nTest 4: message() without isClaudeCode flag")
const transformedWithout = ProviderTransform.message(testMessages as any, mockModel, optionsWithout)
const hasCache2 = JSON.stringify(transformedWithout).includes("cache_control")
console.log("  Has cache_control:", hasCache2)

// Summary
console.log("\n=== RESULTS ===")
const test1Pass = optionsWithout.isClaudeCode === undefined
const test2Pass = optionsWith.isClaudeCode === true
const test3Pass = !hasCache1  // Should NOT have cache_control with isClaudeCode
const test4Pass = hasCache2   // Should have cache_control without isClaudeCode

console.log(`Test 1 (no flag → undefined):     ${test1Pass ? "✓ PASS" : "✗ FAIL"}`)
console.log(`Test 2 (with flag → true):        ${test2Pass ? "✓ PASS" : "✗ FAIL"}`)
console.log(`Test 3 (with flag → no cache):    ${test3Pass ? "✓ PASS" : "✗ FAIL"}`)
console.log(`Test 4 (no flag → has cache):     ${test4Pass ? "✓ PASS" : "✗ FAIL"}`)

const allPass = test1Pass && test2Pass && test3Pass && test4Pass
console.log(`\nOverall: ${allPass ? "✓ ALL TESTS PASS" : "✗ SOME TESTS FAILED"}`)
process.exit(allPass ? 0 : 1)
