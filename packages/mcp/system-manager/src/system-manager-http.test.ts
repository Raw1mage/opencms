import {
  patchSessionExecutionViaApi,
  patchSessionViaApi,
  postSessionRevertViaApi,
  postSessionUnrevertViaApi,
  readSessionInfoViaApi,
  readSessionListViaApi,
  readSessionMessagesViaApi,
  switchAccountViaApi,
  switchModelViaApi,
  type FetchLike,
} from "./system-manager-http"

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

  test("readSessionMessagesViaApi reads DB-backed dialog route with cursor params", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return okJson([
        { info: { id: "msg_2", time: { created: 2 } }, parts: [] },
        { info: { id: "msg_1", time: { created: 1 } }, parts: [] },
      ])
    }

    const messages = await readSessionMessagesViaApi({
      fetchImpl,
      baseUrl: "http://127.0.0.1:1080/api/v2",
      headers: new Headers(),
      sessionID: "ses_db",
      limit: 50,
      before: "msg_3",
    })

    expect(calls[0]?.url).toBe("http://127.0.0.1:1080/api/v2/session/ses_db/message?limit=50&before=msg_3")
    expect(messages.map((m) => m.info.id)).toEqual(["msg_1", "msg_2"])
  })

  test("readSessionInfoViaApi and readSessionListViaApi use session API instead of storage files", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith("/session/ses_db")) return okJson({ id: "ses_db", title: "DB" })
      return okJson([{ id: "ses_db", title: "DB" }])
    }

    await readSessionInfoViaApi({
      fetchImpl,
      baseUrl: "http://127.0.0.1:1080/api/v2",
      headers: new Headers(),
      sessionID: "ses_db",
    })
    const list = await readSessionListViaApi({
      fetchImpl,
      baseUrl: "http://127.0.0.1:1080/api/v2",
      headers: new Headers(),
      search: "DB",
      limit: 5,
    })

    expect(calls[0]?.url).toBe("http://127.0.0.1:1080/api/v2/session/ses_db")
    expect(calls[1]?.url).toBe("http://127.0.0.1:1080/api/v2/session?search=DB&limit=5")
    expect(list).toHaveLength(1)
  })

  test("postSessionRevertViaApi and postSessionUnrevertViaApi call session mutation routes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return okJson({})
    }

    await postSessionRevertViaApi({
      fetchImpl,
      baseUrl: "http://127.0.0.1:1080/api/v2",
      headers: new Headers(),
      sessionID: "ses_db",
      messageID: "msg_1",
    })
    await postSessionUnrevertViaApi({
      fetchImpl,
      baseUrl: "http://127.0.0.1:1080/api/v2",
      headers: new Headers(),
      sessionID: "ses_db",
    })

    expect(calls[0]?.url).toBe("http://127.0.0.1:1080/api/v2/session/ses_db/revert")
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ messageID: "msg_1" }))
    expect(calls[1]?.url).toBe("http://127.0.0.1:1080/api/v2/session/ses_db/unrevert")
    expect(calls[1]?.init?.method).toBe("POST")
  })
})
