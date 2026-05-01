export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<any>
  text?(): Promise<string>
}>

async function readErrorText(response: Awaited<ReturnType<FetchLike>>) {
  return response.text ? await response.text().catch(() => "") : ""
}

export async function switchAccountViaApi(input: {
  fetchImpl: FetchLike
  baseUrl: string
  headers: Headers
  family: string
  accountId: string
}) {
  input.headers.set("content-type", "application/json")
  const response = await input.fetchImpl(`${input.baseUrl}/account/${encodeURIComponent(input.family)}/active`, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify({ accountId: input.accountId, providerKey: input.family }),
  })
  if (!response.ok) throw new Error(`Failed to switch global account for ${input.family}: HTTP ${response.status}`)
}

export async function switchModelViaApi(input: {
  fetchImpl: FetchLike
  baseUrl: string
  getHeaders: Headers
  patchHeaders: Headers
  providerId: string
  modelID: string
}) {
  const current = await input.fetchImpl(`${input.baseUrl}/model/preferences`, { headers: input.getHeaders })
  if (!current.ok) throw new Error(`Failed to read model preferences: HTTP ${current.status}`)
  const prefs = (await current.json().catch(() => undefined)) as
    | { favorite?: Array<{ providerId: string; modelID: string }>; hidden?: unknown[]; hiddenProviders?: string[] }
    | undefined

  input.patchHeaders.set("content-type", "application/json")
  const patchResponse = await input.fetchImpl(`${input.baseUrl}/model/preferences`, {
    method: "PATCH",
    headers: input.patchHeaders,
    body: JSON.stringify({
      favorite: [
        { providerId: input.providerId, modelID: input.modelID },
        ...(prefs?.favorite ?? []).filter((m) => !(m.providerId === input.providerId && m.modelID === input.modelID)),
      ],
      hidden: prefs?.hidden ?? [],
      hiddenProviders: prefs?.hiddenProviders ?? [],
    }),
  })
  if (!patchResponse.ok) throw new Error(`Failed to switch global model preference: HTTP ${patchResponse.status}`)
}

export async function patchSessionViaApi(input: {
  fetchImpl: FetchLike
  baseUrl: string
  headers: Headers
  sessionID: string
  body: Record<string, unknown>
  errorPrefix: string
}) {
  input.headers.set("content-type", "application/json")
  const response = await input.fetchImpl(`${input.baseUrl}/session/${encodeURIComponent(input.sessionID)}`, {
    method: "PATCH",
    headers: input.headers,
    body: JSON.stringify(input.body),
  })
  if (!response.ok) throw new Error(`${input.errorPrefix}: HTTP ${response.status}`)
}

export async function patchSessionExecutionViaApi(input: {
  fetchImpl: FetchLike
  baseUrl: string
  headers: Headers
  sessionID: string
  providerId: string
  modelID: string
  accountId?: string
}) {
  await patchSessionViaApi({
    fetchImpl: input.fetchImpl,
    baseUrl: input.baseUrl,
    headers: input.headers,
    sessionID: input.sessionID,
    body: {
      execution: {
        providerId: input.providerId,
        modelID: input.modelID,
        ...(input.accountId ? { accountId: input.accountId } : {}),
      },
    },
    errorPrefix: `Failed to update session execution for ${input.sessionID}`,
  })
}

export async function readSessionMessagesViaApi(input: {
  fetchImpl: FetchLike
  baseUrl: string
  headers: Headers
  sessionID: string
  limit?: number
  before?: string
}) {
  input.headers.set("Accept", "application/json")
  const params = new URLSearchParams()
  if (input.limit !== undefined) params.set("limit", String(input.limit))
  if (input.before) params.set("before", input.before)
  const query = params.toString()
  const response = await input.fetchImpl(
    `${input.baseUrl}/session/${encodeURIComponent(input.sessionID)}/message${query ? `?${query}` : ""}`,
    { headers: input.headers },
  )
  if (response.status === 404) throw new Error(`session_not_found:${input.sessionID}`)
  if (!response.ok) {
    const text = await readErrorText(response)
    throw new Error(`session_messages_http_${response.status}:${text.slice(0, 400)}`)
  }
  const messages = (await response.json()) as Array<{ info: any; parts: any[] }>
  messages.sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0))
  return messages
}

export async function readSessionInfoViaApi(input: {
  fetchImpl: FetchLike
  baseUrl: string
  headers: Headers
  sessionID: string
}) {
  input.headers.set("Accept", "application/json")
  const response = await input.fetchImpl(`${input.baseUrl}/session/${encodeURIComponent(input.sessionID)}`, {
    headers: input.headers,
  })
  if (response.status === 404) throw new Error(`session_not_found:${input.sessionID}`)
  if (!response.ok) {
    const text = await readErrorText(response)
    throw new Error(`session_info_http_${response.status}:${text.slice(0, 400)}`)
  }
  return response.json() as Promise<any>
}

export async function readSessionListViaApi(input: {
  fetchImpl: FetchLike
  baseUrl: string
  headers: Headers
  search?: string
  limit?: number
  roots?: boolean
}) {
  input.headers.set("Accept", "application/json")
  const params = new URLSearchParams()
  if (input.search) params.set("search", input.search)
  if (input.limit !== undefined) params.set("limit", String(input.limit))
  if (input.roots !== undefined) params.set("roots", String(input.roots))
  const query = params.toString()
  const response = await input.fetchImpl(`${input.baseUrl}/session${query ? `?${query}` : ""}`, {
    headers: input.headers,
  })
  if (!response.ok) {
    const text = await readErrorText(response)
    throw new Error(`session_list_http_${response.status}:${text.slice(0, 400)}`)
  }
  const sessions = (await response.json()) as any[]
  if (!Array.isArray(sessions)) throw new Error("session_list_invalid_payload")
  return sessions
}

export async function postSessionRevertViaApi(input: {
  fetchImpl: FetchLike
  baseUrl: string
  headers: Headers
  sessionID: string
  messageID: string
}) {
  input.headers.set("content-type", "application/json")
  const response = await input.fetchImpl(`${input.baseUrl}/session/${encodeURIComponent(input.sessionID)}/revert`, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify({ messageID: input.messageID }),
  })
  if (!response.ok) {
    const text = await readErrorText(response)
    throw new Error(`session_revert_http_${response.status}:${text.slice(0, 400)}`)
  }
}

export async function postSessionUnrevertViaApi(input: {
  fetchImpl: FetchLike
  baseUrl: string
  headers: Headers
  sessionID: string
}) {
  const response = await input.fetchImpl(`${input.baseUrl}/session/${encodeURIComponent(input.sessionID)}/unrevert`, {
    method: "POST",
    headers: input.headers,
  })
  if (!response.ok) {
    const text = await readErrorText(response)
    throw new Error(`session_unrevert_http_${response.status}:${text.slice(0, 400)}`)
  }
}
