import { afterEach, describe, expect, it, mock } from "bun:test"

const sweepSharedGoogleAccessToken = mock(async () => null)
const activeGoogleAppIds = mock(async () => ["gmail"])
const subscribe = mock(() => () => {})
const publish = mock(async () => {})

mock.module("./app-registry", () => ({
  ManagedAppRegistry: {
    Event: {
      Updated: Symbol("managed-app.updated"),
    },
    activeGoogleAppIds,
  },
}))

mock.module("./apps/google-calendar", () => ({
  GoogleCalendarApp: {
    execute: async () => "",
  },
}))

mock.module("./apps/gmail", () => ({
  GmailApp: {
    execute: async () => "",
  },
}))

mock.module("../config/config", () => ({
  Config: {
    get: async () => ({ mcp: {} }),
  },
}))

mock.module("../util/log", () => ({
  Log: {
    create: () => ({
      info: () => {},
      error: () => {},
      debug: () => {},
      warn: () => {},
    }),
  },
}))

mock.module("../project/instance", () => ({
  Instance: {
    directory: "/tmp",
  },
}))

mock.module("../installation", () => ({
  Installation: {
    VERSION: "test-version",
  },
}))

mock.module("@/util/timeout", () => ({
  withTimeout: (promise: Promise<unknown>) => promise,
}))

mock.module("./oauth-provider", () => ({
  McpOAuthProvider: class McpOAuthProvider {},
}))

mock.module("./oauth-callback", () => ({
  McpOAuthCallback: {
    ensureRunning: async () => {},
    waitForCallback: async () => "code",
    cancelPending: () => {},
  },
}))

mock.module("./auth", () => ({
  McpAuth: {
    updateOAuthState: async () => {},
    getOAuthState: async () => undefined,
    clearOAuthState: async () => {},
    clearCodeVerifier: async () => {},
    remove: async () => {},
    get: async () => undefined,
    isTokenExpired: async () => false,
  },
}))

mock.module("./apps/gauth", () => ({
  sweepSharedGoogleAccessToken,
}))

mock.module("../bus/bus-event", () => ({
  BusEvent: {
    define: (name: string, schema: unknown) => ({ name, schema }),
  },
}))

mock.module("@/bus", () => ({
  Bus: {
    subscribe,
    publish,
  },
}))

mock.module("@/cli/cmd/tui/event", () => ({
  TuiEvent: {
    ToastShow: Symbol("toast"),
  },
}))

mock.module("open", () => ({
  default: async () => ({
    on: () => {},
  }),
}))

mock.module("@/env", () => ({
  Env: {
    all: () => ({}),
  },
}))

describe("MCP startup Google token sweep", () => {
  afterEach(() => {
    sweepSharedGoogleAccessToken.mockClear()
    activeGoogleAppIds.mockReset()
    activeGoogleAppIds.mockResolvedValue(["gmail"])
    subscribe.mockClear()
    publish.mockClear()
  })

  it("runs the shared Google token sweep once on lazy MCP init", async () => {
    const { MCP } = await import("./index")

    await MCP.status()
    await Promise.resolve()
    await Promise.resolve()
    expect(activeGoogleAppIds).toHaveBeenCalledTimes(1)
    expect(sweepSharedGoogleAccessToken).toHaveBeenCalledTimes(1)

    await MCP.status()
    await Promise.resolve()
    expect(sweepSharedGoogleAccessToken).toHaveBeenCalledTimes(1)
  })
})
