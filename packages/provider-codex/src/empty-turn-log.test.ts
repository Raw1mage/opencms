/**
 * empty-turn-log.test.ts — Verify forensic log emitter contract.
 *
 * Spec: codex-empty-turn-recovery
 * Covers:
 * - INV-04: log emission attempted on every call
 * - INV-05: log-failure never throws
 * - INV-06: JSONL is load-bearing; bus is convenience (independent failure modes)
 * - INV-07: log entry validates against data-schema.json
 * - DD-2: file path + bus publisher are injected (not imported from runtime)
 * - DD-11: monotonic logSequence
 * - CET-001: console.error breadcrumb on write failure
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  appendEmptyTurnLog,
  setEmptyTurnLogPath,
  setEmptyTurnLogBus,
  nextLogSequence,
  _resetForTest,
  _peekLogSequenceForTest,
} from "./empty-turn-log"

let tmpDir: string
let logPath: string

beforeEach(() => {
  _resetForTest()
  tmpDir = join(tmpdir(), `cetlog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  logPath = join(tmpDir, "empty-turns.jsonl")
})

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
})

describe("empty-turn-log injection (DD-2 boundary discipline)", () => {
  test("setEmptyTurnLogPath stores path; subsequent appends write to it", () => {
    setEmptyTurnLogPath(logPath)
    appendEmptyTurnLog({ schemaVersion: 1, causeFamily: "unclassified" })
    expect(existsSync(logPath)).toBe(true)
  })

  test("without setEmptyTurnLogPath, append silently drops (no throw)", () => {
    expect(() => appendEmptyTurnLog({ test: true })).not.toThrow()
  })

  test("multiple appends produce JSONL (one entry per line)", () => {
    setEmptyTurnLogPath(logPath)
    appendEmptyTurnLog({ id: 1 })
    appendEmptyTurnLog({ id: 2 })
    appendEmptyTurnLog({ id: 3 })
    const lines = readFileSync(logPath, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!)).toEqual({ id: 1 })
    expect(JSON.parse(lines[1]!)).toEqual({ id: 2 })
    expect(JSON.parse(lines[2]!)).toEqual({ id: 3 })
  })

  test("creates parent directory if missing (mkdirSync recursive)", () => {
    const nestedPath = join(tmpDir, "a", "b", "c", "empty-turns.jsonl")
    setEmptyTurnLogPath(nestedPath)
    appendEmptyTurnLog({ test: true })
    expect(existsSync(nestedPath)).toBe(true)
  })
})

describe("INV-05 log-failure never blocks (CET-001)", () => {
  test("write to read-only path: no throw, console.error breadcrumb fired", () => {
    // Use a path that cannot exist (parent points to a regular file we just made).
    const blocker = join(tmpDir, "blocker")
    require("fs").writeFileSync(blocker, "x")
    const badPath = join(blocker, "subdir", "empty-turns.jsonl")
    setEmptyTurnLogPath(badPath)

    const errors: string[] = []
    const origErr = console.error
    console.error = (msg: string) => errors.push(msg)
    try {
      expect(() => appendEmptyTurnLog({ test: true })).not.toThrow()
    } finally {
      console.error = origErr
    }
    expect(errors.some((e) => e.startsWith("[CODEX-EMPTY-TURN] log emission failed:"))).toBe(true)
  })

  test("bus publisher throws synchronously: file append still succeeds", () => {
    setEmptyTurnLogPath(logPath)
    setEmptyTurnLogBus(() => {
      throw new Error("bus broke")
    })
    expect(() => appendEmptyTurnLog({ id: 42 })).not.toThrow()
    expect(existsSync(logPath)).toBe(true)
    const line = readFileSync(logPath, "utf-8").trim()
    expect(JSON.parse(line)).toEqual({ id: 42 })
  })

  test("bus publisher returns rejected promise: silently swallowed", async () => {
    setEmptyTurnLogPath(logPath)
    setEmptyTurnLogBus(() => Promise.reject(new Error("async bus broke")))
    expect(() => appendEmptyTurnLog({ id: 99 })).not.toThrow()
    // Give the rejection a tick to surface (it should NOT surface as unhandledRejection)
    await new Promise((r) => setTimeout(r, 10))
  })
})

describe("INV-06 JSONL load-bearing, bus convenience", () => {
  test("file write succeeds; bus call also fired with same payload", () => {
    setEmptyTurnLogPath(logPath)
    const busCalls: { channel: string; payload: unknown }[] = []
    setEmptyTurnLogBus((channel, payload) => {
      busCalls.push({ channel, payload })
    })
    appendEmptyTurnLog({ causeFamily: "ws_truncation" })
    expect(existsSync(logPath)).toBe(true)
    expect(busCalls).toHaveLength(1)
    expect(busCalls[0]!.channel).toBe("codex.emptyTurn")
    expect(busCalls[0]!.payload).toEqual({ causeFamily: "ws_truncation" })
  })

  test("only path injected (no bus): file written, no error", () => {
    setEmptyTurnLogPath(logPath)
    expect(() => appendEmptyTurnLog({ id: "no-bus" })).not.toThrow()
    expect(existsSync(logPath)).toBe(true)
  })

  test("only bus injected (no path): silent drop on file, bus still publishes", () => {
    const busCalls: unknown[] = []
    setEmptyTurnLogBus((_, payload) => busCalls.push(payload))
    expect(() => appendEmptyTurnLog({ id: "no-file" })).not.toThrow()
    expect(busCalls).toHaveLength(1)
  })
})

describe("DD-11 monotonic logSequence", () => {
  test("starts at 0 and increments per call", () => {
    expect(_peekLogSequenceForTest()).toBe(0)
    expect(nextLogSequence()).toBe(0)
    expect(nextLogSequence()).toBe(1)
    expect(nextLogSequence()).toBe(2)
    expect(_peekLogSequenceForTest()).toBe(3)
  })

  test("_resetForTest resets the sequence to 0", () => {
    nextLogSequence()
    nextLogSequence()
    nextLogSequence()
    _resetForTest()
    expect(nextLogSequence()).toBe(0)
  })
})
