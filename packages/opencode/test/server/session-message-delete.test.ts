import { describe, expect, test } from "bun:test"
import path from "path"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Flag } from "../../src/flag/flag"

const projectRoot = path.join(__dirname, "../..")

describe("session.deleteMessage", () => {
  test("deletes a session message by ID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({ title: "delete-message-test" })

        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: {
            providerId: "opencode",
            modelID: "big-pickle",
          },
        })

        let messages = await Session.messages({ sessionID: session.id })
        expect(messages.some((m) => m.info.id === messageID)).toBe(true)

        const response = await app.request(`/session/${session.id}/message/${messageID}`, {
          method: "DELETE",
        })
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        expect(response.status).toBe(200)
        expect(await response.json()).toBe(true)

        messages = await Session.messages({ sessionID: session.id })
        expect(messages.some((m) => m.info.id === messageID)).toBe(false)
      },
    })
  })
})
