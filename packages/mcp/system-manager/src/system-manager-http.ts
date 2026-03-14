export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<any>
}>

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
