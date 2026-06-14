import { describe, expect, test } from "bun:test"
import { classifyFreerunNaturalEntry, parseFreerunActivation, parseFreerunCommand } from "./freerun-command"

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

  test("parses strong natural activation phrases", () => {
    expect(parseFreerunActivation("開始執行 整理 gdrive 根目錄")).toEqual({
      verb: "arm",
      goal: "整理 gdrive 根目錄",
    })
    expect(parseFreerunActivation("接著跑")).toBeUndefined()
    expect(parseFreerunActivation("只是討論一下")).toBeUndefined()
  })

  test("classifies readiness suggestions without auto-starting", () => {
    expect(classifyFreerunNaturalEntry("目標：整理 GDrive 根目錄\n範圍：只處理 root\n完成標準：產出分類報告")).toEqual({
      kind: "ready",
      suggestion: "可進入 freerun 拆解執行",
    })
    expect(
      parseFreerunActivation("目標：整理 GDrive 根目錄\n範圍：只處理 root\n完成標準：產出分類報告"),
    ).toBeUndefined()
  })

  test("classifies weak or no-goal phrases as clarification instead of activation", () => {
    expect(classifyFreerunNaturalEntry("接著跑")).toEqual({ kind: "clarify" })
    expect(classifyFreerunNaturalEntry("go")).toEqual({ kind: "clarify" })
    expect(parseFreerunActivation("接著跑")).toBeUndefined()
    expect(parseFreerunActivation("go")).toBeUndefined()
  })
})
