import { describe, expect, test } from "bun:test"
import {
  CLAUDE_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  streamIdleTimeoutMs,
  usesFirstChunkWatchdog,
} from "./stream-watchdog"

describe("stream-watchdog idle timeout policy", () => {
  test("claude-cli gets the wider idle budget (fixes 2026-05-31 mid-write false-abort)", () => {
    expect(streamIdleTimeoutMs("claude-cli")).toBe(CLAUDE_STREAM_IDLE_TIMEOUT_MS)
    expect(CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe(240_000)
  })

  test("claude budget exceeds its measured 178s prefill worst-case", () => {
    expect(CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBeGreaterThan(178_000)
  })

  test("claude budget stays under the provider-level 300s hard ceiling", () => {
    // A genuine wedge must still be caught (later) rather than hanging to 300s.
    expect(CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBeLessThan(300_000)
  })

  test("codex keeps the 90s default (its documented 0-byte wedge target)", () => {
    expect(streamIdleTimeoutMs("codex")).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(90_000)
  })

  test("unknown / other providers keep the 90s default", () => {
    expect(streamIdleTimeoutMs("copilot-cli")).toBe(90_000)
    expect(streamIdleTimeoutMs("")).toBe(90_000)
  })
})

describe("stream-watchdog first-chunk policy", () => {
  test("only codex arms the first-chunk watchdog", () => {
    expect(usesFirstChunkWatchdog("codex")).toBe(true)
  })

  test("claude does NOT arm the first-chunk watchdog (178s prefill is legitimate)", () => {
    expect(usesFirstChunkWatchdog("claude-cli")).toBe(false)
  })

  test("other providers do not arm the first-chunk watchdog", () => {
    expect(usesFirstChunkWatchdog("copilot-cli")).toBe(false)
  })
})
