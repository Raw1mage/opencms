import { patchSessionViaApi, switchAccountViaApi, switchModelViaApi, type FetchLike } from "./system-manager-http"

function okJson(data: any) {
  return {
    ok: true,
    status: 200,
    async json() {
      return data
    },
  }
}

describe("system-manager http helpers", () => {
  test("switchAccountViaApi posts account.setActive route", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return okJson(true)
    }

    await switchAccountViaApi({
      fetchImpl,
      baseUrl: "http://127.0.0.1:1080/api/v2",
      headers: new Headers(),
      family: "openai",
      accountId: "acc_1",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://127.0.0.1:1080/api/v2/account/openai/active")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ accountId: "acc_1", providerKey: "openai" }))
  })

  test("switchModelViaApi reads then patches model preferences", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      if (calls.length === 1) {
        return okJson({
          favorite: [{ providerId: "openai", modelID: "gpt-old" }],
          hidden: [],
          hiddenProviders: [],
        })
      }
      return okJson({})
    }

    await switchModelViaApi({
      fetchImpl,
      baseUrl: "http://127.0.0.1:1080/api/v2",
      getHeaders: new Headers(),
      patchHeaders: new Headers(),
      providerId: "openai",
      modelID: "gpt-new",
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe("http://127.0.0.1:1080/api/v2/model/preferences")
    expect(calls[1]?.url).toBe("http://127.0.0.1:1080/api/v2/model/preferences")
    expect(calls[1]?.init?.method).toBe("PATCH")
    expect(calls[1]?.init?.body).toBe(
      JSON.stringify({
        favorite: [
          { providerId: "openai", modelID: "gpt-new" },
          { providerId: "openai", modelID: "gpt-old" },
        ],
        hidden: [],
        hiddenProviders: [],
      }),
    )
  })

  test("patchSessionViaApi patches session.update route for rename", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return okJson({})
    }

    await patchSessionViaApi({
      fetchImpl,
      baseUrl: "http://127.0.0.1:1080/api/v2",
      headers: new Headers(),
      sessionID: "ses_123",
      body: { title: "Renamed" },
      errorPrefix: "Failed to rename session ses_123",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://127.0.0.1:1080/api/v2/session/ses_123")
    expect(calls[0]?.init?.method).toBe("PATCH")
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ title: "Renamed" }))
  })

  test("patchSessionViaApi patches session.update route for execution switch", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return okJson({})
    }

    await patchSessionViaApi({
      fetchImpl,
      baseUrl: "http://127.0.0.1:1080/api/v2",
      headers: new Headers(),
      sessionID: "ses_456",
      body: { execution: { providerId: "openai", modelID: "gpt-5.4", accountId: "acc_2" } },
      errorPrefix: "Failed to update session execution for ses_456",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://127.0.0.1:1080/api/v2/session/ses_456")
    expect(calls[0]?.init?.method).toBe("PATCH")
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ execution: { providerId: "openai", modelID: "gpt-5.4", accountId: "acc_2" } }),
    )
  })

  test("patchSessionExecutionViaApi builds execution patch payload", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return okJson({})
    }

    await patchSessionExecutionViaApi({
      fetchImpl,
      baseUrl: "http://127.0.0.1:1080/api/v2",
      headers: new Headers(),
      sessionID: "ses_789",
      providerId: "openai",
      modelID: "gpt-5.2",
      accountId: "acc_3",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://127.0.0.1:1080/api/v2/session/ses_789")
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ execution: { providerId: "openai", modelID: "gpt-5.2", accountId: "acc_3" } }),
    )
  })
})
import {
  patchSessionExecutionViaApi,
  patchSessionViaApi,
  switchAccountViaApi,
  switchModelViaApi,
  type FetchLike,
} from "./system-manager-http"
import {
  patchSessionExecutionViaApi,
  patchSessionViaApi,
  switchAccountViaApi,
  switchModelViaApi,
  type FetchLike,
} from "./system-manager-http"
