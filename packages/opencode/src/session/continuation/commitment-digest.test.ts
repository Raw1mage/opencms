import { describe, expect, it } from "bun:test"
import type { MessageV2 } from "../message-v2"
import {
  classifyBashAsMutation,
  COMMITMENT_DIGEST_SENTINEL,
  isMutationToolCall,
  renderDigest,
  renderToolPartAsEntry,
  type CommitmentDigestEntry,
} from "./commitment-digest"

function makeToolPart(input: {
  tool: string
  callID?: string
  status?: "completed" | "error" | "pending" | "running"
  toolInput?: Record<string, any>
  output?: string
  error?: string
  end?: number
}): MessageV2.ToolPart {
  const time = { start: 1_000, end: input.end ?? 2_000 }
  if (input.status === "pending") {
    return {
      id: "prt_" + Math.random().toString(36).slice(2, 8),
      messageID: "msg_x",
      sessionID: "ses_x",
      type: "tool",
      callID: input.callID ?? "call_" + Math.random().toString(36).slice(2, 8),
      tool: input.tool,
      state: { status: "pending" } as any,
    } as MessageV2.ToolPart
  }
  if (input.status === "running") {
    return {
      id: "prt_" + Math.random().toString(36).slice(2, 8),
      messageID: "msg_x",
      sessionID: "ses_x",
      type: "tool",
      callID: input.callID ?? "call_" + Math.random().toString(36).slice(2, 8),
      tool: input.tool,
      state: {
        status: "running",
        input: input.toolInput ?? {},
        title: "",
        metadata: {},
        time: { start: 1_000 },
      } as any,
    } as MessageV2.ToolPart
  }
  if (input.status === "error") {
    return {
      id: "prt_" + Math.random().toString(36).slice(2, 8),
      messageID: "msg_x",
      sessionID: "ses_x",
      type: "tool",
      callID: input.callID ?? "call_" + Math.random().toString(36).slice(2, 8),
      tool: input.tool,
      state: {
        status: "error",
        input: input.toolInput ?? {},
        error: input.error ?? "boom",
        metadata: {},
        time,
      } as any,
    } as MessageV2.ToolPart
  }
  return {
    id: "prt_" + Math.random().toString(36).slice(2, 8),
    messageID: "msg_x",
    sessionID: "ses_x",
    type: "tool",
    callID: input.callID ?? "call_" + Math.random().toString(36).slice(2, 8),
    tool: input.tool,
    state: {
      status: "completed",
      input: input.toolInput ?? {},
      output: input.output ?? "ok",
      title: "",
      metadata: {},
      time,
    } as any,
  } as MessageV2.ToolPart
}

describe("continuation/commitment-digest", () => {
  // ----- classifyBashAsMutation -----

  describe("classifyBashAsMutation", () => {
    it.each([
      ['git commit -m "x"', true],
      ["git add -A", true],
      ["git push origin main", true],
      ['echo hi > foo.txt', true],
      ["mv a.ts b.ts", true],
      ["rm -rf .cache", true],
      ['sed -i "s/a/b/" foo.txt', true],
      ["mkdir foo", true],
      ["chmod +x bin/run", true],
      ["bun install lodash", true],
      ["pip install requests", true],
      ['echo hi >> log.txt', true],
    ] as const)("write effect: %s → true", (cmd, expected) => {
      expect(classifyBashAsMutation(cmd)).toBe(expected)
    })

    it.each([
      ["ls -la", false],
      ["cat foo.txt", false],
      ["grep -r foo .", false],
      ["curl https://example.com/api", false],
      ["jq . foo.json", false],
      ["find . -name '*.ts'", false],
      ["head -20 foo.txt", false],
      ["git status", false],
      ["git log --oneline", false],
      ["git diff", false],
    ] as const)("read-only: %s → false", (cmd, expected) => {
      expect(classifyBashAsMutation(cmd)).toBe(expected)
    })

    it("undefined / empty / non-string → false", () => {
      expect(classifyBashAsMutation(undefined)).toBe(false)
      expect(classifyBashAsMutation("")).toBe(false)
    })
  })

  // ----- isMutationToolCall -----

  describe("isMutationToolCall", () => {
    it("apply_patch → mutation", () => {
      expect(isMutationToolCall(makeToolPart({ tool: "apply_patch" }))).toBe(true)
    })

    it("edit → mutation", () => {
      expect(isMutationToolCall(makeToolPart({ tool: "edit" }))).toBe(true)
    })

    it("write → mutation", () => {
      expect(isMutationToolCall(makeToolPart({ tool: "write" }))).toBe(true)
    })

    it("move_file → mutation", () => {
      expect(isMutationToolCall(makeToolPart({ tool: "move_file" }))).toBe(true)
    })

    it("delete_file → mutation", () => {
      expect(isMutationToolCall(makeToolPart({ tool: "delete_file" }))).toBe(true)
    })

    it("read → NOT mutation (DD-2)", () => {
      expect(isMutationToolCall(makeToolPart({ tool: "read" }))).toBe(false)
    })

    it("grep → NOT mutation", () => {
      expect(isMutationToolCall(makeToolPart({ tool: "grep" }))).toBe(false)
    })

    it("bash with write command → mutation", () => {
      expect(
        isMutationToolCall(
          makeToolPart({ tool: "bash", toolInput: { command: "git commit -m x" } }),
        ),
      ).toBe(true)
    })

    it("bash with read-only command → NOT mutation", () => {
      expect(
        isMutationToolCall(makeToolPart({ tool: "bash", toolInput: { command: "ls -la" } })),
      ).toBe(false)
    })

    it("bash with no command field → NOT mutation", () => {
      expect(isMutationToolCall(makeToolPart({ tool: "bash", toolInput: {} }))).toBe(false)
    })
  })

  // ----- renderToolPartAsEntry -----

  describe("renderToolPartAsEntry", () => {
    it("apply_patch completed → extracts target file from patch text", () => {
      const part = makeToolPart({
        tool: "apply_patch",
        callID: "call_p1",
        toolInput: { input: "*** Begin Patch\n*** Update File: foo/bar.md\n@@\n-x\n+y\n" },
        output: "Success. Updated the following files:\nM foo/bar.md",
      })
      const entry = renderToolPartAsEntry(part)
      expect(entry).not.toBeNull()
      expect(entry!.call_id).toBe("call_p1")
      expect(entry!.tool).toBe("apply_patch")
      expect(entry!.args_brief).toBe("foo/bar.md")
      expect(entry!.status).toBe("completed")
      expect(entry!.output_summary).toBe("✓ Success")
    })

    it("apply_patch with no patch path → falls back to (patch)", () => {
      const part = makeToolPart({
        tool: "apply_patch",
        toolInput: { input: "garbage no header" },
        output: "Success.",
      })
      const entry = renderToolPartAsEntry(part)
      expect(entry!.args_brief).toBe("(patch)")
    })

    it("write completed → uses filePath", () => {
      const part = makeToolPart({
        tool: "write",
        callID: "call_w1",
        toolInput: { filePath: "/home/x/foo.ts" },
        output: "wrote 42 bytes",
      })
      const entry = renderToolPartAsEntry(part)
      expect(entry!.args_brief).toBe("/home/x/foo.ts")
    })

    it("bash → command as args_brief", () => {
      const part = makeToolPart({
        tool: "bash",
        toolInput: { command: "git commit -m feat" },
        output: "[main abcd] feat\n 1 file changed",
      })
      const entry = renderToolPartAsEntry(part)
      expect(entry!.args_brief).toBe("git commit -m feat")
    })

    it("error state → status=failed, output_summary=error first line", () => {
      const part = makeToolPart({
        tool: "apply_patch",
        status: "error",
        toolInput: { input: "*** Update File: foo\n" },
        error: "patch did not apply\nat line 5",
      })
      const entry = renderToolPartAsEntry(part)
      expect(entry!.status).toBe("failed")
      expect(entry!.output_summary).toBe("patch did not apply")
    })

    it("pending / running states → null (incomplete)", () => {
      const p1 = makeToolPart({ tool: "edit", status: "pending" })
      const p2 = makeToolPart({ tool: "edit", status: "running" })
      expect(renderToolPartAsEntry(p1)).toBeNull()
      expect(renderToolPartAsEntry(p2)).toBeNull()
    })

    it("args_brief truncates to 80 chars", () => {
      const longPath = "a/".repeat(100) + "x.ts"
      const part = makeToolPart({ tool: "write", toolInput: { filePath: longPath } })
      const entry = renderToolPartAsEntry(part)
      expect(entry!.args_brief.length).toBeLessThanOrEqual(80)
      expect(entry!.args_brief.endsWith("…")).toBe(true)
    })

    it("output_summary truncates to 60 chars", () => {
      const part = makeToolPart({
        tool: "bash",
        toolInput: { command: "ls" },
        output: "x".repeat(200),
      })
      const entry = renderToolPartAsEntry(part)
      expect(entry!.output_summary.length).toBeLessThanOrEqual(60)
    })
  })

  // ----- secret scrubbing -----

  describe("scrubbing", () => {
    it("scrubs OpenAI-style sk- keys", () => {
      const part = makeToolPart({
        tool: "bash",
        toolInput: { command: "curl -H 'Authorization: Bearer sk-proj-AbcDEFghIJKLmnopQRSTuvwx1234' x" },
      })
      const entry = renderToolPartAsEntry(part)
      expect(entry!.args_brief).toContain("<scrubbed>")
      expect(entry!.args_brief).not.toContain("sk-proj-AbcDEF")
    })

    it("scrubs GitHub PAT (ghp_)", () => {
      const part = makeToolPart({
        tool: "bash",
        toolInput: { command: "git config token ghp_AbcDEFghIJKLmnopQRSTuvwx" },
      })
      const entry = renderToolPartAsEntry(part)
      expect(entry!.args_brief).not.toContain("ghp_AbcDEF")
    })

    it("scrubs URLs with token query param", () => {
      const part = makeToolPart({
        tool: "bash",
        toolInput: { command: "curl https://api.example.com/x?token=AbCdEf" },
        output: "ok",
      })
      const entry = renderToolPartAsEntry(part)
      expect(entry!.args_brief).toContain("<scrubbed-url>")
    })

    it("does NOT scrub safe identifiers", () => {
      const part = makeToolPart({
        tool: "edit",
        toolInput: { filePath: "foo/bar.md" },
      })
      const entry = renderToolPartAsEntry(part)
      expect(entry!.args_brief).toBe("foo/bar.md")
    })
  })

  // ----- renderDigest -----

  describe("renderDigest", () => {
    it("empty entries → marker line", () => {
      const body = renderDigest([])
      expect(body).toContain("(no recent mutation-class actions recorded)")
    })

    it("renders header + one line per entry", () => {
      const entries: CommitmentDigestEntry[] = [
        { call_id: "call_p1", tool: "apply_patch", args_brief: "foo.md", status: "completed", output_summary: "✓ Success", completed_at: 1 },
        { call_id: "call_p2", tool: "apply_patch", args_brief: "bar.md", status: "completed", output_summary: "✓ Success", completed_at: 2 },
      ]
      const body = renderDigest(entries)
      expect(body).toContain("Recent committed actions")
      expect(body).toContain("call_p1")
      expect(body).toContain("call_p2")
      expect(body).toContain("foo.md")
      expect(body).toContain("bar.md")
    })

    it("failed entries show ✗ marker", () => {
      const body = renderDigest([
        { call_id: "c1", tool: "apply_patch", args_brief: "x", status: "failed", output_summary: "boom", completed_at: 1 },
      ])
      expect(body).toContain("✗")
    })

    it("truncates body to ≤1000 chars even with many entries", () => {
      const entries: CommitmentDigestEntry[] = Array.from({ length: 50 }, (_, i) => ({
        call_id: `call_${i}`,
        tool: "apply_patch",
        args_brief: "x".repeat(70),
        status: "completed" as const,
        output_summary: "y".repeat(50),
        completed_at: i,
      }))
      const body = renderDigest(entries)
      expect(body.length).toBeLessThanOrEqual(1000)
      expect(body).toContain("…truncated")
    })
  })

  // ----- sentinel -----

  describe("sentinel marker", () => {
    it("COMMITMENT_DIGEST_SENTINEL is the documented marker", () => {
      expect(COMMITMENT_DIGEST_SENTINEL).toContain("commitment_digest_unavailable")
    })
  })
})
