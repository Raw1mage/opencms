import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Flag } from "../../src/flag/flag"

const expectNotMismatchGuard = async (response: Response, allowedStatuses: number[]) => {
  if (response.status === 400) {
    const body = (await response.json()) as { code?: string; message?: string; error?: string }
    expect(body.code).not.toBe("ACCOUNT_PROVIDER_MISMATCH")
    return
  }

  expect(allowedStatuses).toContain(response.status)
}

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
    expect(body.message).toContain("google-api !== openai")
  })

  test("login rejects mismatched providerKey query vs legacy :family param", async () => {
    const app = Server.App()
    const response = await app.request("/api/v2/account/auth/openai/login?providerKey=google-api")
    if (response.status === 401) {
      expect(Flag.OPENCODE_SERVER_PASSWORD).toBeTruthy()
      return
    }

    expect(response.status).toBe(400)
    const body = (await response.json()) as { code?: string; message?: string }
    expect(body.code).toBe("ACCOUNT_PROVIDER_MISMATCH")
    expect(body.message).toContain("google-api !== openai")
  })

  test("remove rejects mismatched providerKey query vs legacy :family param", async () => {
    const app = Server.App()
    const response = await app.request("/api/v2/account/openai/dummy-account?providerKey=google-api", {
      method: "DELETE",
    })

    if (Flag.OPENCODE_SERVER_PASSWORD) {
      expect(response.status).toBe(401)
      return
    }

    expect(response.status).toBe(400)
    const body = (await response.json()) as { code?: string; message?: string }
    expect(body.code).toBe("ACCOUNT_PROVIDER_MISMATCH")
    expect(body.message).toContain("google-api !== openai")
  })

  test("update rejects mismatched providerKey body vs legacy :family param", async () => {
    const app = Server.App()
    const response = await app.request("/api/v2/account/openai/dummy-account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed", providerKey: "google-api" }),
    })

    if (Flag.OPENCODE_SERVER_PASSWORD) {
      expect(response.status).toBe(401)
      return
    }

    expect(response.status).toBe(400)
    const body = (await response.json()) as { code?: string; message?: string }
    expect(body.code).toBe("ACCOUNT_PROVIDER_MISMATCH")
    expect(body.message).toContain("google-api !== openai")
  })

  test("setActive does not trigger mismatch guard when providerKey matches legacy :family", async () => {
    const app = Server.App()
    const response = await app.request("/api/v2/account/openai/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "dummy-account", providerKey: "openai" }),
    })

    // Auth / downstream account existence may return non-400 statuses depending on environment;
    // for this guard test we only require that mismatch guard is not the failure reason.
    await expectNotMismatchGuard(response, [200, 401, 404, 503])
  })

  test("login does not trigger mismatch guard when providerKey matches legacy :family", async () => {
    const app = Server.App()
    const response = await app.request("/api/v2/account/auth/openai/login?providerKey=openai")

    if (response.status === 401) {
      expect(Flag.OPENCODE_SERVER_PASSWORD).toBeTruthy()
      return
    }

    await expectNotMismatchGuard(response, [200])
  })

  test("remove does not trigger mismatch guard when providerKey matches legacy :family", async () => {
    const app = Server.App()
    const response = await app.request("/api/v2/account/openai/dummy-account?providerKey=openai", {
      method: "DELETE",
    })

    if (response.status === 401) {
      expect(Flag.OPENCODE_SERVER_PASSWORD).toBeTruthy()
      return
    }

    await expectNotMismatchGuard(response, [200, 404])
  })

  test("update does not trigger mismatch guard when providerKey matches legacy :family", async () => {
    const app = Server.App()
    const response = await app.request("/api/v2/account/openai/dummy-account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed", providerKey: "openai" }),
    })

    if (response.status === 401) {
      expect(Flag.OPENCODE_SERVER_PASSWORD).toBeTruthy()
      return
    }

    await expectNotMismatchGuard(response, [200, 404])
  })
})
