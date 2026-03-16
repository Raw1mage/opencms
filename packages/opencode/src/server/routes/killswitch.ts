import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Config } from "@/config/config"
import { PermissionNext } from "@/permission/next"
import { Session } from "@/session"
import { RequestUser } from "@/runtime/request-user"
import { KillSwitchService } from "../killswitch/service"
import { WebAuth } from "../web-auth"

const ControlAction = z.enum(["pause", "resume", "cancel", "snapshot", "set_priority"])

const AckSchema = z.object({
  requestID: z.string(),
  sessionID: z.string(),
  seq: z.number(),
  status: z.enum(["accepted", "rejected", "error"]),
  reason: z.string().optional(),
  timestamp: z.number(),
})

const TriggerInput = z.object({
  initiator: z.string().optional(),
  reason: z.string().min(1),
  mode: z.string().default("global"),
  scope: z.string().default("global"),
  channelId: z.string().optional(),
  ttl: z.number().optional(),
  mfaCode: z.string().optional(),
  requestID: z.string().optional(),
})

const ControlInput = z.object({
  initiator: z.string().optional(),
  action: ControlAction.default("cancel"),
  seq: z.number().optional(),
})

async function assertKillSwitchOperator(c: any) {
  const requestUser = RequestUser.username()

  if (!WebAuth.enabled()) {
    // Keep local/dev compatibility when web auth is disabled.
    return null
  }

  if (!requestUser) {
    return c.json({ ok: false, error: "auth_required", reason: "operator_auth_required" }, 401)
  }

  const configuredOperator = WebAuth.username()
  if (configuredOperator && requestUser !== configuredOperator) {
    return c.json({ ok: false, error: "forbidden", reason: "operator_mismatch" }, 403)
  }

  const globalConfig = await Config.getGlobal().catch(() => undefined)
  const permissionConfig = globalConfig?.permission
  const ruleset = permissionConfig ? PermissionNext.fromConfig(permissionConfig) : []
  const decision = PermissionNext.evaluate("kill_switch.trigger", "*", ruleset)
  if (decision.action !== "allow") {
    return c.json(
      {
        ok: false,
        error: "forbidden",
        reason: "capability_denied",
        permission: "kill_switch.trigger",
        action: decision.action,
      },
      403,
    )
  }

  return null
}

async function enforceCooldown(c: any, initiator: string, windowMs = 5000) {
  const cd = await KillSwitchService.checkCooldown(initiator, windowMs)
  if (!cd.ok) {
    return c.json({ ok: false, error: "cooldown_active", remainingMs: cd.remainingMs }, 429)
  }
  return null
}

export function KillSwitchRoutes() {
  return new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Get kill-switch status",
        operationId: "killswitch.status",
        responses: {
          200: {
            description: "Kill-switch status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.boolean(),
                    active: z.boolean(),
                    initiator: z.string().nullable(),
                    initiated_at: z.number().nullable(),
                    mode: z.string().nullable(),
                    scope: z.string().nullable(),
                    ttl: z.number().nullable(),
                    snapshot_url: z.string().nullable(),
                    request_id: z.string().nullable().optional(),
                    state: z.string().nullable().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const state = await KillSwitchService.getState()
        if (!state) {
          return c.json({
            ok: true,
            active: false,
            initiator: null,
            initiated_at: null,
            mode: null,
            scope: null,
            ttl: null,
            snapshot_url: null,
          })
        }
        return c.json({
          ok: true,
          active: state.active,
          initiator: state.initiator,
          initiated_at: state.initiatedAt,
          mode: state.mode,
          scope: state.scope,
          ttl: state.ttl ?? null,
          snapshot_url: state.snapshotURL ?? null,
          request_id: state.requestID,
          state: state.state,
        })
      },
    )
    .post(
      "/trigger",
      describeRoute({
        summary: "Trigger kill-switch",
        operationId: "killswitch.trigger",
        responses: {
          200: {
            description: "Triggered",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({ ok: z.boolean(), request_id: z.string(), snapshot_url: z.string().nullable() }),
                ),
              },
            },
          },
        },
      }),
      validator("json", TriggerInput),
      async (c) => {
        const body = c.req.valid("json")
        const roleRej = await assertKillSwitchOperator(c)
        if (roleRej) return roleRej

        const initiator = body.initiator || RequestUser.username() || "unknown"
        const cooldownRej = await enforceCooldown(c, initiator)
        if (cooldownRej) return cooldownRej

        const requestID =
          body.requestID ?? (await KillSwitchService.idempotentRequestID(initiator, body.reason, 10_000))

        if (!body.mfaCode) {
          const code = await KillSwitchService.generateMfa(requestID, initiator)
          await KillSwitchService.writeAudit({
            requestID,
            initiator,
            action: "kill_switch.mfa_challenge_generated",
            permission: "kill_switch.trigger",
            result: "challenge",
          })
          const devCode =
            process.env.NODE_ENV !== "production" || process.env.OPENCODE_DEV_MFA === "true" ? code : undefined
          return c.json(
            {
              ok: true,
              mfa_required: true,
              request_id: requestID,
              ...(devCode ? { dev_code: devCode } : {}),
            },
            202,
          )
        }

        const mfaOk = await KillSwitchService.verifyMfa(requestID, initiator, body.mfaCode)
        if (!mfaOk) {
          await KillSwitchService.writeAudit({
            requestID,
            initiator,
            action: "kill_switch.mfa_failed",
            permission: "kill_switch.trigger",
            result: "denied",
          })
          return c.json({ ok: false, error: "mfa_invalid", request_id: requestID }, 401)
        }

        const initiatedAt = Date.now()
        const snapshotURL = await KillSwitchService.createSnapshotPlaceholder({
          requestID,
          initiator,
          mode: body.mode,
          scope: body.scope,
          reason: body.reason,
        })

        await KillSwitchService.setState({
          active: true,
          state: "soft_paused",
          requestID,
          initiator,
          reason: body.reason,
          initiatedAt,
          mode: body.mode,
          scope: body.channelId ? "channel" : body.scope,
          channelId: body.channelId,
          ttl: body.ttl ?? null,
          snapshotURL,
        })

        await KillSwitchService.writeAudit({
          requestID,
          initiator,
          action: "kill_switch.trigger",
          permission: "kill_switch.trigger",
          result: "accepted",
          meta: { mode: body.mode, scope: body.channelId ? "channel" : body.scope, channelId: body.channelId, snapshotURL },
        })

        // soft-pause/hard-kill path: cancel all busy sessions with seq/ack
        // If channelId is set, only cancel sessions belonging to that channel
        const busy = await KillSwitchService.listBusySessionIDs(body.channelId)
        const failures: Array<{ sessionID: string; reason: string }> = []
        for (const sessionID of busy) {
          const seq = Date.now()
          try {
            const ack = await KillSwitchService.publishControl({
              requestID,
              sessionID,
              seq,
              action: "cancel",
              initiator,
              timeoutMs: 5000,
            })
            if (ack.status !== "accepted") {
              await KillSwitchService.forceKill(sessionID, requestID, initiator, `ack_${ack.status}`)
              failures.push({ sessionID, reason: `ack_${ack.status}` })
            }
          } catch (error: any) {
            await KillSwitchService.forceKill(sessionID, requestID, initiator, "ack_timeout")
            failures.push({ sessionID, reason: error?.message ?? String(error) })
          }
        }

        if (failures.length) {
          await KillSwitchService.writeAudit({
            requestID,
            initiator,
            action: "kill_switch.trigger_partial",
            result: "partial",
            reason: "some_sessions_force_killed",
            meta: { failures },
          })
        }

        return c.json({ ok: true, request_id: requestID, snapshot_url: snapshotURL })
      },
    )
    .post(
      "/cancel",
      describeRoute({
        summary: "Cancel kill-switch",
        operationId: "killswitch.cancel",
        responses: {
          200: {
            description: "Canceled",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), request_id: z.string().nullable().optional() })),
              },
            },
          },
        },
      }),
      validator("json", z.object({ requestID: z.string().optional(), initiator: z.string().optional() })),
      async (c) => {
        const body = c.req.valid("json")
        const roleRej = await assertKillSwitchOperator(c)
        if (roleRej) return roleRej
        const initiator = body.initiator || RequestUser.username() || "unknown"
        const cooldownRej = await enforceCooldown(c, initiator)
        if (cooldownRej) return cooldownRej
        await KillSwitchService.clearState()
        await KillSwitchService.writeAudit({
          requestID: body.requestID,
          initiator,
          action: "kill_switch.cancel",
          permission: "kill_switch.trigger",
          result: "accepted",
        })
        return c.json({ ok: true, request_id: body.requestID ?? null })
      },
    )
    .post(
      "/tasks/:sessionID/control",
      describeRoute({
        summary: "Control one session task",
        operationId: "killswitch.task.control",
        responses: {
          200: {
            description: "Control applied",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.boolean(),
                    request_id: z.string(),
                    session_id: z.string(),
                    ack: AckSchema.optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator("param", z.object({ sessionID: Session.get.schema })),
      validator("json", ControlInput),
      async (c) => {
        const roleRej = await assertKillSwitchOperator(c)
        if (roleRej) return roleRej
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        const initiator = body.initiator || RequestUser.username() || "unknown"
        const cooldownRej = await enforceCooldown(c, initiator)
        if (cooldownRej) return cooldownRej

        const requestID = await KillSwitchService.idempotentRequestID(
          initiator,
          `task:${params.sessionID}:${body.action}`,
          5000,
        )
        const seq = body.seq ?? Date.now()
        try {
          const ack = await KillSwitchService.publishControl({
            requestID,
            sessionID: params.sessionID,
            action: body.action,
            seq,
            initiator,
            timeoutMs: 5000,
          })
          if (ack.status !== "accepted") {
            await KillSwitchService.forceKill(params.sessionID, requestID, initiator, `ack_${ack.status}`)
            return c.json(
              { ok: false, request_id: requestID, session_id: params.sessionID, ack, error: "worker_ack_rejected" },
              502,
            )
          }
          return c.json({ ok: true, request_id: requestID, session_id: params.sessionID, ack })
        } catch (error: any) {
          await KillSwitchService.forceKill(params.sessionID, requestID, initiator, "ack_timeout")
          return c.json(
            {
              ok: false,
              request_id: requestID,
              session_id: params.sessionID,
              error: "worker_ack_timeout",
              message: error?.message ?? String(error),
            },
            504,
          )
        }
      },
    )
}
