import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import z from "zod"

/**
 * E2E test for kill-switch: UI → API → state change → snapshot (Task 4.2)
 *
 * Exercises the full lifecycle:
 *   1. GET /status → inactive
 *   2. POST /trigger (no MFA) → 202 + MFA challenge
 *   3. POST /trigger (with MFA) → 200 + snapshot_url + state set
 *   4. GET /status → active
 *   5. POST /cancel → 200 + state cleared
 *   6. GET /status → inactive
 */

type AckLike = {
  requestID: string
  sessionID: string
  seq: number
  status: "accepted" | "rejected" | "error"
  reason?: string
  timestamp: number
}

let currentRequestUser: string | undefined = "operator"
let webAuthEnabled = false
let webAuthOperator: string | undefined = "operator"
let globalPermissionConfig: Record<string, any> | undefined

// Stateful mocks to simulate real service behavior
let currentState: any = undefined
let mfaStore: Map<string, { code: string; initiator: string; expiresAt: number }> = new Map()
let auditLog: Array<Record<string, any>> = []
let cooldownMap: Map<string, number> = new Map()

const checkCooldown = mock(async (initiator: string, windowMs = 5000) => {
  const prev = cooldownMap.get(initiator)
  const now = Date.now()
  if (prev && now - prev < windowMs) {
    return { ok: false, remainingMs: windowMs - (now - prev) }
  }
  cooldownMap.set(initiator, now)
  return { ok: true, remainingMs: 0 }
})

const idempotentRequestID = mock(async () => "ks_e2e_req_1")

const generateMfa = mock(async (requestID: string, initiator: string) => {
  const code = "654321"
  mfaStore.set(requestID, { code, initiator, expiresAt: Date.now() + 300000 })
  return code
})

const writeAudit = mock(async (entry: any) => {
  auditLog.push({ ...entry, timestamp: Date.now() })
})

const verifyMfa = mock(async (requestID: string, initiator: string, code: string) => {
  const token = mfaStore.get(requestID)
  if (!token) return false
  if (token.initiator !== initiator) return false
  if (Date.now() > token.expiresAt) return false
  if (token.code !== code) return false
  mfaStore.delete(requestID)
  return true
})

const createSnapshotPlaceholder = mock(async () => "local://killswitch/snapshot-ks_e2e_req_1.json")

const setState = mock(async (state: any) => {
  currentState = state
})

const getState = mock(async () => currentState)

const clearState = mock(async () => {
  currentState = undefined
})

const listBusySessionIDs = mock(() => ["ses_busy_1"])

const publishControl = mock(
  async (): Promise<AckLike> => ({
    requestID: "ks_e2e_req_1",
    sessionID: "ses_busy_1",
    seq: Date.now(),
    status: "accepted" as const,
    timestamp: Date.now(),
  }),
)

const forceKill = mock(async () => undefined)

mock.module("../killswitch/service", () => ({
  KillSwitchService: {
    checkCooldown,
    idempotentRequestID,
    generateMfa,
    writeAudit,
    verifyMfa,
    createSnapshotPlaceholder,
    setState,
    getState,
    clearState,
    listBusySessionIDs,
    publishControl,
    forceKill,
  },
}))

mock.module("@/runtime/request-user", () => ({
  RequestUser: {
    username: () => currentRequestUser,
  },
}))

mock.module("../web-auth", () => ({
  WebAuth: {
    enabled: () => webAuthEnabled,
    username: () => webAuthOperator,
  },
}))

mock.module("@/config/config", () => ({
  Config: {
    getGlobal: async () => ({
      permission: globalPermissionConfig,
    }),
  },
}))

mock.module("@/permission/next", () => ({
  PermissionNext: {
    fromConfig: (config: any) => {
      // Convert permission config to a simple ruleset for evaluate()
      return Object.entries(config ?? {}).map(([key, value]) => ({ permission: key, action: value }))
    },
    evaluate: (permission: string, _scope: string, ruleset: any[]) => {
      const rule = ruleset.find((r: any) => r.permission === permission)
      return { action: rule?.action ?? "allow" }
    },
  },
}))

mock.module("@/session", () => ({
  Session: {
    get: {
      schema: z.string().startsWith("ses"),
    },
  },
}))

let KillSwitchRoutes: typeof import("./killswitch").KillSwitchRoutes

describe("Kill-switch E2E lifecycle", () => {
  beforeAll(async () => {
    ;({ KillSwitchRoutes } = await import("./killswitch"))
  })

  beforeEach(() => {
    currentRequestUser = "operator"
    webAuthEnabled = false
    webAuthOperator = "operator"
    globalPermissionConfig = { "kill_switch.trigger": "allow" }
    currentState = undefined
    mfaStore.clear()
    auditLog = []
    cooldownMap.clear()

    checkCooldown.mockClear()
    idempotentRequestID.mockClear()
    generateMfa.mockClear()
    writeAudit.mockClear()
    verifyMfa.mockClear()
    createSnapshotPlaceholder.mockClear()
    setState.mockClear()
    getState.mockClear()
    clearState.mockClear()
    listBusySessionIDs.mockClear()
    publishControl.mockClear()
    forceKill.mockClear()
  })

  it("full lifecycle: status → trigger(MFA) → trigger(code) → status → cancel → status", async () => {
    const app = KillSwitchRoutes()

    // Step 1: GET /status → inactive
    const res1 = await app.request("http://localhost/status")
    const body1 = await res1.json()
    expect(res1.status).toBe(200)
    expect(body1.active).toBe(false)
    expect(body1.initiator).toBeNull()

    // Step 2: POST /trigger without MFA → 202 challenge
    const res2 = await app.request("http://localhost/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "e2e incident test" }),
    })
    const body2 = await res2.json()
    expect(res2.status).toBe(202)
    expect(body2.mfa_required).toBe(true)
    expect(body2.request_id).toBe("ks_e2e_req_1")
    expect(generateMfa).toHaveBeenCalledTimes(1)

    // Step 3: POST /trigger with MFA code → 200 + snapshot
    // Need to clear cooldown for same initiator
    cooldownMap.clear()
    const res3 = await app.request("http://localhost/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "e2e incident test",
        requestID: "ks_e2e_req_1",
        mfaCode: "654321",
      }),
    })
    const body3 = await res3.json()
    expect(res3.status).toBe(200)
    expect(body3.ok).toBe(true)
    expect(body3.request_id).toBe("ks_e2e_req_1")
    expect(body3.snapshot_url).toBe("local://killswitch/snapshot-ks_e2e_req_1.json")
    expect(setState).toHaveBeenCalledTimes(1)
    expect(createSnapshotPlaceholder).toHaveBeenCalledTimes(1)
    // Verify busy sessions were controlled
    expect(publishControl).toHaveBeenCalledTimes(1)

    // Step 4: GET /status → active
    const res4 = await app.request("http://localhost/status")
    const body4 = await res4.json()
    expect(res4.status).toBe(200)
    expect(body4.active).toBe(true)
    expect(body4.state).toBe("soft_paused")
    expect(body4.request_id).toBe("ks_e2e_req_1")
    expect(body4.snapshot_url).toBe("local://killswitch/snapshot-ks_e2e_req_1.json")

    // Step 5: POST /cancel → 200
    cooldownMap.clear()
    const res5 = await app.request("http://localhost/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestID: "ks_e2e_req_1" }),
    })
    const body5 = await res5.json()
    expect(res5.status).toBe(200)
    expect(body5.ok).toBe(true)
    expect(clearState).toHaveBeenCalledTimes(1)

    // Step 6: GET /status → inactive again
    const res6 = await app.request("http://localhost/status")
    const body6 = await res6.json()
    expect(res6.status).toBe(200)
    expect(body6.active).toBe(false)

    // Verify audit trail captured all actions
    expect(auditLog.length).toBeGreaterThanOrEqual(3)
    const actions = auditLog.map((e) => e.action)
    expect(actions).toContain("kill_switch.mfa_challenge_generated")
    expect(actions).toContain("kill_switch.trigger")
    expect(actions).toContain("kill_switch.cancel")
  })

  it("MFA code rejected on wrong code", async () => {
    const app = KillSwitchRoutes()

    // Generate MFA challenge
    await app.request("http://localhost/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "wrong code test" }),
    })

    // Submit wrong code
    cooldownMap.clear()
    const res = await app.request("http://localhost/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "wrong code test",
        requestID: "ks_e2e_req_1",
        mfaCode: "000000",
      }),
    })
    const body = await res.json()
    expect(res.status).toBe(401)
    expect(body.error).toBe("mfa_invalid")
    expect(setState).not.toHaveBeenCalled()

    // Verify MFA failure was audited
    const failAudit = auditLog.find((e) => e.action === "kill_switch.mfa_failed")
    expect(failAudit).toBeDefined()
  })

  it("cooldown enforced between rapid trigger attempts", async () => {
    const app = KillSwitchRoutes()

    // First trigger → 202 (OK)
    const res1 = await app.request("http://localhost/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "cooldown test" }),
    })
    expect(res1.status).toBe(202)

    // Immediate second trigger → 429 (cooldown)
    const res2 = await app.request("http://localhost/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "cooldown test 2" }),
    })
    const body2 = await res2.json()
    expect(res2.status).toBe(429)
    expect(body2.error).toBe("cooldown_active")
  })

  it("RBAC enforcement: operator mismatch + capability denied", async () => {
    webAuthEnabled = true
    const app = KillSwitchRoutes()

    // Operator mismatch
    webAuthOperator = "admin"
    currentRequestUser = "operator"
    const res1 = await app.request("http://localhost/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "rbac test" }),
    })
    expect(res1.status).toBe(403)
    const body1 = await res1.json()
    expect(body1.reason).toBe("operator_mismatch")

    // Capability denied
    webAuthOperator = "operator"
    currentRequestUser = "operator"
    globalPermissionConfig = { "kill_switch.trigger": "deny" }
    cooldownMap.clear()
    const res2 = await app.request("http://localhost/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "rbac test 2" }),
    })
    expect(res2.status).toBe(403)
    const body2 = await res2.json()
    expect(body2.reason).toBe("capability_denied")
  })

  it("snapshot included in trigger response and state", async () => {
    const app = KillSwitchRoutes()

    // Trigger with MFA bypass (pre-seed MFA store)
    mfaStore.set("ks_e2e_req_1", { code: "654321", initiator: "operator", expiresAt: Date.now() + 300000 })

    const res = await app.request("http://localhost/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "snapshot test",
        requestID: "ks_e2e_req_1",
        mfaCode: "654321",
      }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.snapshot_url).toBe("local://killswitch/snapshot-ks_e2e_req_1.json")

    // Verify state was set with snapshot URL
    const stateCall = setState.mock.calls[0][0]
    expect(stateCall.snapshotURL).toBe("local://killswitch/snapshot-ks_e2e_req_1.json")
    expect(stateCall.active).toBe(true)
    expect(stateCall.state).toBe("soft_paused")
  })
})
