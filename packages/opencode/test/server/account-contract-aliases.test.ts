import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Flag } from "../../src/flag/flag"

describe("account contract canonical + legacy aliases", () => {
  test("list endpoint exposes canonical providers with legacy families alias", async () => {
    const app = Server.App()
    const response = await app.request("/api/v2/account")

    if (response.status === 401) {
      expect(Flag.OPENCODE_SERVER_PASSWORD).toBeTruthy()
      return
    }

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      providers?: Record<string, unknown>
      families?: Record<string, unknown>
    }

    expect(body.providers).toBeDefined()
    expect(body.families).toBeDefined()
    expect(typeof body.providers).toBe("object")
    expect(typeof body.families).toBe("object")
    expect(JSON.stringify(body.providers)).toBe(JSON.stringify(body.families))
  })

  test("quota endpoint exposes canonical providerKey with legacy family alias", async () => {
    const app = Server.App()
    const response = await app.request("/api/v2/account/quota?providerId=openai")

    if (response.status === 401) {
      expect(Flag.OPENCODE_SERVER_PASSWORD).toBeTruthy()
      return
    }

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      providerId?: string
      providerKey?: string
      family?: string
    }

    expect(body.providerId).toBe("openai")
    expect(body.providerKey).toBeDefined()
    expect(body.family).toBeDefined()
    expect(body.providerKey).toBe(body.family)
  })
})
