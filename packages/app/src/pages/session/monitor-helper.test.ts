import { describe, expect, test } from "bun:test"
import { buildMonitorEntries } from "./monitor-helper"

describe("buildMonitorEntries", () => {
  test("links task monitor entries back to todo step metadata and latest result", () => {
    const entries = buildMonitorEntries({
      raw: [
        {
          id: "tool:session_1:part_1",
          level: "tool",
          sessionID: "session_1",
          title: "API audit",
          status: { type: "working" },
          agent: "coding",
          model: { providerId: "openai", modelID: "gpt-5" },
          requests: 1,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          totalTokens: 0,
          activeTool: "task",
          activeToolStatus: "completed",
          updated: 1,
        },
      ],
      messages: [
        {
          id: "m1",
          sessionID: "session_1",
          role: "assistant",
          parentID: "u1",
          modelID: "gpt-5",
          providerId: "openai",
          mode: "default",
          agent: "coding",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1 },
        } as any,
      ],
      partsByMessage: {
        m1: [
          {
            id: "part_1",
            sessionID: "session_1",
            messageID: "m1",
            type: "tool",
            callID: "call_1",
            tool: "task",
            metadata: {
              todo: {
                id: "todo_1",
                content: "Audit API edge cases",
                status: "in_progress",
                action: { kind: "delegate", canDelegate: true },
              },
            },
            state: {
              status: "completed",
              output: "done",
              title: "report ready",
              time: { start: 1, end: 2 },
            },
          } as any,
        ],
      },
    })

    expect(entries).toMatchObject([
      {
        todo: {
          id: "todo_1",
          content: "Audit API edge cases",
        },
        latestResult: "report ready",
      },
    ])
  })
})
