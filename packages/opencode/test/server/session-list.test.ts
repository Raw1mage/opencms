import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { ClaudeImport } from "../../src/session/claude-import"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"
import { Flag } from "../../src/flag/flag"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.list", () => {
  test("lists sessions across directories by default", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        const first = await Session.create({})

        const otherDir = path.join(projectRoot, "..", "__session_list_global")
        const second = await Instance.provide({
          directory: otherDir,
          fn: async () => Session.create({}),
        })

        const response = await app.request(`/session`)
        expect(response.status).toBe(200)

        const body = (await response.json()) as unknown[]
        const ids = body
          .map((s) => (typeof s === "object" && s && "id" in s ? (s as { id: string }).id : undefined))
          .filter((x): x is string => typeof x === "string")

        expect(ids).toContain(first.id)
        expect(ids).toContain(second.id)
      },
    })
  })

  test("filters by directory", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        const first = await Session.create({})

        const otherDir = path.join(projectRoot, "..", "__session_list_other")
        const second = await Instance.provide({
          directory: otherDir,
          fn: async () => Session.create({}),
        })

        const response = await app.request(`/session?directory=${encodeURIComponent(projectRoot)}`)
        expect(response.status).toBe(200)

        const body = (await response.json()) as unknown[]
        const ids = body
          .map((s) => (typeof s === "object" && s && "id" in s ? (s as { id: string }).id : undefined))
          .filter((x): x is string => typeof x === "string")

        expect(ids).toContain(first.id)
        expect(ids).not.toContain(second.id)
      },
    })
  })

  test("filters root sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        const root = await Session.create({ title: "root-session" })
        const child = await Session.create({ title: "child-session", parentID: root.id })

        const response = await app.request(`/session?roots=true`)
        expect(response.status).toBe(200)

        const body = (await response.json()) as Array<{ id: string }>
        const ids = body.map((x) => x.id)

        expect(ids).toContain(root.id)
        expect(ids).not.toContain(child.id)
      },
    })
  })

  test("filters by search term", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        await Session.create({ title: "unique-search-term-abc" })
        await Session.create({ title: "other-session-xyz" })

        const response = await app.request(`/session?search=${encodeURIComponent("unique-search")}`)
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        expect(response.status).toBe(200)

        const body = (await response.json()) as Array<{ title: string }>
        const titles = body.map((x) => x.title)

        expect(titles).toContain("unique-search-term-abc")
        expect(titles).not.toContain("other-session-xyz")
      },
    })
  })

  test("filters by start time", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        await Session.create({ title: "new-session" })
        const futureStart = Date.now() + 86400000

        const response = await app.request(`/session?start=${futureStart}`)
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        expect(response.status).toBe(200)

        const body = (await response.json()) as unknown[]
        expect(body.length).toBe(0)
      },
    })
  })

  test("respects limit parameter", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        await Session.create({ title: "session-1" })
        await Session.create({ title: "session-2" })
        await Session.create({ title: "session-3" })

        const response = await app.request(`/session?limit=2`)
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        expect(response.status).toBe(200)

        const body = (await response.json()) as unknown[]
        expect(body.length).toBe(2)
      },
    })
  })

  test("filters Claude sessions by explicit execution identity", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        const claudeByProvider = await Session.create({ title: "claude-provider-session" })
        await Session.update(claudeByProvider.id, (draft) => {
          draft.execution = {
            providerId: "anthropic",
            modelID: "not-claude-name",
            accountId: "anthropic-account",
            revision: 1,
            updatedAt: Date.now(),
          }
        })

        const claudeByModel = await Session.create({ title: "claude-model-session" })
        await Session.update(claudeByModel.id, (draft) => {
          draft.execution = {
            providerId: "openrouter",
            modelID: "anthropic/claude-sonnet-4",
            accountId: "openrouter-account",
            revision: 1,
            updatedAt: Date.now(),
          }
        })

        const nonClaude = await Session.create({ title: "non-claude-session" })
        await Session.update(nonClaude.id, (draft) => {
          draft.execution = {
            providerId: "openai",
            modelID: "gpt-5.5",
            accountId: "openai-account",
            revision: 1,
            updatedAt: Date.now(),
          }
        })

        const noExecution = await Session.create({ title: "no-execution-session" })

        const otherDir = path.join(projectRoot, "..", "__session_list_claude_other")
        const otherProjectClaude = await Instance.provide({
          directory: otherDir,
          fn: async () => {
            const session = await Session.create({ title: "other-project-claude-session" })
            await Session.update(session.id, (draft) => {
              draft.execution = {
                providerId: "anthropic",
                modelID: "claude-other-project",
                accountId: "other-project-account",
                revision: 1,
                updatedAt: Date.now(),
              }
            })
            return session
          },
        })

        const response = await app.request(
          `/session?directory=${encodeURIComponent(projectRoot)}&providerFamily=claude`,
        )
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        expect(response.status).toBe(200)

        const body = (await response.json()) as Array<{
          id: string
          execution?: { providerId: string; modelID: string }
        }>
        const ids = body.map((x) => x.id)

        expect(ids).toContain(claudeByProvider.id)
        expect(ids).toContain(claudeByModel.id)
        expect(ids).not.toContain(nonClaude.id)
        expect(ids).not.toContain(noExecution.id)
        expect(ids).not.toContain(otherProjectClaude.id)
        expect(body.find((x) => x.id === claudeByProvider.id)?.execution?.providerId).toBe("anthropic")
        expect(body.find((x) => x.id === claudeByModel.id)?.execution?.modelID).toBe("anthropic/claude-sonnet-4")
      },
    })
  })

  test("imports Claude Code transcript deterministically and delta-syncs", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const transcriptPath = path.join(os.tmpdir(), `opencode-test-claude-import-${process.pid}.jsonl`)
        await fs.writeFile(
          transcriptPath,
          [
            JSON.stringify({
              timestamp: "2026-05-04T10:00:00.000Z",
              message: { role: "user", content: [{ type: "text", text: "Please inspect the sidebar." }] },
            }),
            JSON.stringify({
              timestamp: "2026-05-04T10:00:01.000Z",
              cwd: projectRoot,
              message: {
                role: "assistant",
                model: "claude-sonnet-4",
                content: [
                  { type: "text", text: "I inspected it." },
                  { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "sidebar.tsx" } },
                  { type: "tool_result", tool_use_id: "toolu_1", content: "large output omitted" },
                ],
                usage: { input_tokens: 10, output_tokens: 5 },
              },
            }),
          ].join("\n") + "\n",
        )

        const first = await app.request("/session/import/claude", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: projectRoot, sourceSessionID: "claude-test", transcriptPath }),
        })
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(first.status).toBe(401)
          return
        }
        expect(first.status).toBe(200)
        const firstBody = (await first.json()) as { sessionID: string; imported: boolean; appended: number }
        expect(firstBody.imported).toBe(true)
        expect(firstBody.appended).toBe(2)

        const messages = await Session.messages({ sessionID: firstBody.sessionID })
        expect(messages.map((msg) => msg.info.role)).toEqual(["user", "assistant"])
        const textParts = messages.flatMap((msg) => msg.parts).filter((part) => part.type === "text")
        expect(textParts.length).toBe(2)
        expect(textParts.some((part) => part.synthetic === true)).toBe(false)
        expect(messages[1].parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")).toContain(
          "Runtime evidence",
        )

        await fs.appendFile(
          transcriptPath,
          JSON.stringify({
            timestamp: "2026-05-04T10:00:02.000Z",
            message: { role: "user", content: "Continue from here." },
          }) + "\n",
        )
        const second = await app.request("/session/import/claude", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: projectRoot, sourceSessionID: "claude-test", transcriptPath }),
        })
        expect(second.status).toBe(200)
        const secondBody = (await second.json()) as { sessionID: string; imported: boolean; appended: number }
        expect(secondBody.sessionID).toBe(firstBody.sessionID)
        expect(secondBody.imported).toBe(false)
        expect(secondBody.appended).toBe(1)
      },
    })
  })

  test("writes takeover anchor for large Claude Code transcript and keeps import idempotent", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const transcriptPath = path.join(os.tmpdir(), `opencode-test-claude-import-anchor-${process.pid}.jsonl`)
        const lines = Array.from({ length: 20 }, (_, index) => {
          const role = index % 2 === 0 ? "user" : "assistant"
          return JSON.stringify({
            timestamp: `2026-05-04T10:00:${String(index).padStart(2, "0")}.000Z`,
            cwd: projectRoot,
            message: {
              role,
              model: role === "assistant" ? "claude-sonnet-4" : undefined,
              content: [{ type: "text", text: `${role} takeover line ${index + 1}` }],
            },
          })
        })
        await fs.writeFile(transcriptPath, lines.join("\n") + "\n")

        const first = await app.request("/session/import/claude", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: projectRoot, sourceSessionID: "claude-anchor", transcriptPath }),
        })
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(first.status).toBe(401)
          return
        }
        expect(first.status).toBe(200)
        const firstBody = (await first.json()) as { sessionID: string; imported: boolean; appended: number }
        expect(firstBody.appended).toBe(20)

        const messages = await Session.messages({ sessionID: firstBody.sessionID })
        const anchors = messages.filter((msg) => msg.info.role === "assistant" && msg.info.summary === true)
        expect(anchors.length).toBe(1)
        expect(anchors[0].parts.some((part) => part.type === "compaction")).toBe(true)
        expect(anchors[0].parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")).toContain(
          "Claude Takeover Anchor",
        )

        const filtered = await MessageV2.filterCompacted(MessageV2.stream(firstBody.sessionID))
        expect(filtered.messages.map((msg) => msg.info.id)).toEqual([anchors[0].info.id])

        const second = await app.request("/session/import/claude", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: projectRoot, sourceSessionID: "claude-anchor", transcriptPath }),
        })
        expect(second.status).toBe(200)
        const secondBody = (await second.json()) as { sessionID: string; imported: boolean; appended: number }
        expect(secondBody.sessionID).toBe(firstBody.sessionID)
        expect(secondBody.appended).toBe(0)
        const unchanged = await Session.messages({ sessionID: firstBody.sessionID })
        expect(unchanged.filter((msg) => msg.info.role === "assistant" && msg.info.summary === true).length).toBe(1)

        await fs.appendFile(
          transcriptPath,
          JSON.stringify({
            timestamp: "2026-05-04T10:00:21.000Z",
            message: { role: "user", content: [{ type: "text", text: "new takeover delta" }] },
          }) + "\n",
        )
        const third = await app.request("/session/import/claude", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: projectRoot, sourceSessionID: "claude-anchor", transcriptPath }),
        })
        expect(third.status).toBe(200)
        const thirdBody = (await third.json()) as { sessionID: string; imported: boolean; appended: number }
        expect(thirdBody.appended).toBe(1)
        const refreshed = await Session.messages({ sessionID: firstBody.sessionID })
        expect(refreshed.filter((msg) => msg.info.role === "assistant" && msg.info.summary === true).length).toBe(2)
      },
    })
  })

  test("keeps Claude import metadata isolated by directory", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const otherDir = path.join(projectRoot, "..", `__claude_import_other_${process.pid}`)
        const sourceSessionID = `claude-shared-source-${process.pid}`
        const firstTranscript = path.join(os.tmpdir(), `opencode-test-claude-import-first-${process.pid}.jsonl`)
        const secondTranscript = path.join(os.tmpdir(), `opencode-test-claude-import-second-${process.pid}.jsonl`)
        await fs.writeFile(
          firstTranscript,
          JSON.stringify({ message: { role: "user", content: "First workspace transcript." } }) + "\n",
        )
        await fs.writeFile(
          secondTranscript,
          JSON.stringify({ message: { role: "user", content: "Second workspace transcript." } }) + "\n",
        )

        const first = await app.request("/session/import/claude", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: projectRoot, sourceSessionID, transcriptPath: firstTranscript }),
        })
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(first.status).toBe(401)
          return
        }
        expect(first.status).toBe(200)
        const firstBody = (await first.json()) as { sessionID: string; imported: boolean; appended: number }
        expect(firstBody.imported).toBe(true)
        expect(firstBody.appended).toBe(1)

        const second = await app.request("/session/import/claude", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: otherDir, sourceSessionID, transcriptPath: secondTranscript }),
        })
        expect(second.status).toBe(200)
        const secondBody = (await second.json()) as { sessionID: string; imported: boolean; appended: number }
        expect(secondBody.imported).toBe(true)
        expect(secondBody.appended).toBe(1)
        expect(secondBody.sessionID).not.toBe(firstBody.sessionID)

        const firstMessages = await Session.messages({ sessionID: firstBody.sessionID })
        const secondMessages = await Session.messages({ sessionID: secondBody.sessionID })
        expect(
          firstMessages
            .map((msg) => msg.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"))
            .join("\n"),
        ).toContain("First workspace transcript.")
        expect(
          firstMessages
            .map((msg) => msg.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"))
            .join("\n"),
        ).not.toContain("Second workspace transcript.")
        expect(
          secondMessages
            .map((msg) => msg.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"))
            .join("\n"),
        ).toContain("Second workspace transcript.")
      },
    })
  })

  test("marks Claude native sessions with new content since last import", async () => {
    const previousHome = process.env.OPENCODE_TEST_HOME
    const testHome = path.join(os.tmpdir(), `opencode-test-claude-home-${process.pid}`)
    process.env.OPENCODE_TEST_HOME = testHome
    try {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const projectKey = projectRoot.replace(/[^a-zA-Z0-9]/g, "-")
          const transcriptDir = path.join(testHome, ".claude", "projects", projectKey)
          await fs.mkdir(transcriptDir, { recursive: true })
          const transcriptPath = path.join(transcriptDir, "green-dot-test.jsonl")
          await fs.writeFile(
            transcriptPath,
            JSON.stringify({ message: { role: "user", content: "Initial import." } }) + "\n",
          )

          const firstImport = await ClaudeImport.importTranscript({
            directory: projectRoot,
            sourceSessionID: "green-dot-test",
          })
          expect(firstImport.appended).toBe(1)

          const freshRows = await ClaudeImport.listNative({ directory: projectRoot })
          const fresh = freshRows.find((row) => row.sourceSessionID === "green-dot-test")
          expect(fresh?.currentLineCount).toBe(1)
          expect(fresh?.importedLineCount).toBe(1)
          expect(fresh?.hasNewContent).toBe(false)

          await fs.appendFile(
            transcriptPath,
            JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "New content." }] } }) +
              "\n",
          )
          const staleRows = await ClaudeImport.listNative({ directory: projectRoot })
          const stale = staleRows.find((row) => row.sourceSessionID === "green-dot-test")
          expect(stale?.currentLineCount).toBe(2)
          expect(stale?.importedLineCount).toBe(1)
          expect(stale?.hasNewContent).toBe(true)
        },
      })
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = previousHome
    }
  })

  test("fails fast for unsupported Claude transcript blocks", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const transcriptPath = path.join(os.tmpdir(), `opencode-test-claude-import-unsupported-${process.pid}.jsonl`)
        await fs.writeFile(
          transcriptPath,
          JSON.stringify({
            message: { role: "assistant", content: [{ type: "image", source: "unsupported" }] },
          }) + "\n",
        )
        const response = await app.request("/session/import/claude", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: projectRoot, sourceSessionID: "claude-bad", transcriptPath }),
        })
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        expect(response.status).toBe(400)
        const body = (await response.json()) as { code: string }
        expect(body.code).toBe("CLAUDE_UNSUPPORTED_BLOCK")
      },
    })
  })
})
