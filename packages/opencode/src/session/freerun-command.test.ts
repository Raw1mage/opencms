import { describe, expect, test } from "bun:test"
import { parseFreerunCommand } from "./freerun-command"

describe("parseFreerunCommand", () => {
  test("parses routing commands", () => {
    expect(parseFreerunCommand("/freerun on")).toEqual({ verb: "on" })
    expect(parseFreerunCommand("/freerun off")).toEqual({ verb: "off" })
    expect(parseFreerunCommand("/freerun clear")).toEqual({ verb: "clear" })
  })

  test("parses explicit arm command with optional goal", () => {
    expect(parseFreerunCommand("/freerun arm Build a demo")).toEqual({ verb: "arm", goal: "Build a demo" })
    expect(parseFreerunCommand("/freerun arm")).toEqual({ verb: "arm" })
  })

  test("parses disarm and ignores normal chat", () => {
    expect(parseFreerunCommand("/freerun disarm")).toEqual({ verb: "disarm" })
    expect(parseFreerunCommand("please freerun arm this later")).toBeUndefined()
  })
})
