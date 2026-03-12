import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Flag } from "../../src/flag/flag"

describe("account providerKey compatibility guard", () => {
  test("setActive rejects mismatched providerKey body vs legacy :family param", async () => {
    const app = Server.App()
    const response = await app.request("/api/v2/account/openai/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "dummy-account", providerKey: "google-api" }),
    })

    if (Flag.OPENCODE_SERVER_PASSWORD) {
      expect(response.status).toBe(401)
      return
    }

    expect(response.status).toBe(400)
    const body = (await response.json()) as { code?: string; message?: string }
    expect(body.code).toBe("ACCOUNT_PROVIDER_MISMATCH")
  })

  test("login rejects mismatched providerKey query vs legacy :family param", async () => {
    const app = Server.App()
    const response = await app.request("/api/v2/account/auth/openai/login?providerKey=google-api")
    expect(response.status).toBe(400)
    const body = (await response.json()) as { code?: string; message?: string }
    expect(body.code).toBe("ACCOUNT_PROVIDER_MISMATCH")
  })
})
