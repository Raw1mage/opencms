export type KillSwitchStatus = {
  active: boolean
  requestID: string | null
  state: string | null
  snapshotURL: string | null
}

export const normalizeKillSwitchStatus = (input: unknown): KillSwitchStatus => {
  const value = (input ?? {}) as Record<string, unknown>
  const active = value.active === true
  const requestID = typeof value.request_id === "string" ? value.request_id : null
  const state = typeof value.state === "string" ? value.state : null
  const snapshotURL = typeof value.snapshot_url === "string" ? value.snapshot_url : null
  return { active, requestID, state, snapshotURL }
}

export const buildTriggerPayload = (input: { reason: string; requestID?: string; mfaCode?: string; snapshot?: boolean }) => {
  const payload: { reason: string; requestID?: string; mfaCode?: string; snapshot?: boolean } = {
    reason: input.reason,
  }
  if (input.requestID) payload.requestID = input.requestID
  if (input.mfaCode) payload.mfaCode = input.mfaCode
  if (input.snapshot !== undefined) payload.snapshot = input.snapshot
  return payload
}
