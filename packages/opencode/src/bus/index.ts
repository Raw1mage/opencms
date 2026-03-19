import z from "zod"
import { Instance } from "../project/instance"
import { BusEvent } from "./bus-event"
import { GlobalBus } from "./global"
import { getLogLevel, type LogLevel } from "./log-level"
import { setDebugHandler } from "./sink"
import type { BusContext } from "./bus-context"

export type { BusContext } from "./bus-context"

export namespace Bus {
  type Subscription = (event: any) => void

  export const InstanceDisposed = BusEvent.define(
    "server.instance.disposed",
    z.object({
      directory: z.string(),
    }),
  )

  // @event_20260319_daemonization Phase ε.1 — Account lifecycle events
  // Payload is sanitized (no apiKey / refreshToken / accessToken)
  export const AccountAdded = BusEvent.define(
    "account.added",
    z.object({
      providerKey: z.string(),
      accountId: z.string(),
      info: z.object({
        type: z.enum(["api", "subscription"]),
        name: z.string(),
        addedAt: z.number(),
      }),
    }),
  )

  export const AccountRemoved = BusEvent.define(
    "account.removed",
    z.object({
      providerKey: z.string(),
      accountId: z.string(),
    }),
  )

  export const AccountActivated = BusEvent.define(
    "account.activated",
    z.object({
      providerKey: z.string(),
      accountId: z.string(),
      previousAccountId: z.string().optional(),
    }),
  )

  // Module-level (global) subscriber registry — survives across instances.
  // Used by cross-cutting subscribers: debug-writer, tui-toaster, etc.
  const globalSubscriptions = new Map<string, Subscription[]>()

  // Lazy Instance.state() to break circular dependency:
  // index.ts → debug-writer → bus/index → Instance → bus/index (TDZ)
  let _state: ReturnType<typeof Instance.state> | undefined
  function state() {
    if (!_state) {
      _state = Instance.state(
        () => {
          const subscriptions = new Map<any, Subscription[]>()
          return { subscriptions }
        },
        async (_entry) => {
          // Instance disposal event is published via Bus.publish in Instance.dispose(),
          // before State.dispose runs. No duplicate dispatch needed here.
        },
      )
    }
    return _state()
  }

  function resolveContext(overrides?: Partial<BusContext>): BusContext {
    return {
      directory: overrides?.directory ?? Instance.directory,
      worktree: overrides?.worktree ?? Instance.worktree,
      projectId: overrides?.projectId ?? Instance.project.id,
      ...(overrides?.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    }
  }

  export async function publish<Definition extends BusEvent.Definition>(
    def: Definition,
    properties: z.output<Definition["properties"]>,
    context?: Partial<BusContext>,
  ) {
    const ctx = resolveContext(context)
    const payload = {
      type: def.type,
      properties,
    }
    const pending = []
    const envelope = { ...payload, context: ctx }
    // Instance-scoped subscribers
    for (const key of [def.type, "*"]) {
      const match = state().subscriptions.get(key)
      for (const sub of match ?? []) {
        pending.push(sub(envelope))
      }
    }
    // Global subscribers (debug-writer, tui-toaster, etc.)
    for (const key of [def.type, "*"]) {
      const match = globalSubscriptions.get(key)
      for (const sub of match ?? []) {
        pending.push(sub(envelope))
      }
    }
    GlobalBus.emit("event", {
      directory: ctx.directory,
      context: ctx,
      payload,
    })
    return Promise.all(pending)
  }

  export function subscribe<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: { type: Definition["type"]; properties: z.infer<Definition["properties"]>; context: BusContext }) => void,
  ) {
    return raw(def.type, callback)
  }

  export function once<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: {
      type: Definition["type"]
      properties: z.infer<Definition["properties"]>
      context: BusContext
    }) => "done" | undefined,
  ) {
    const unsub = subscribe(def, (event) => {
      if (callback(event)) unsub()
    })
  }

  export function subscribeAll(callback: (event: any) => void) {
    return raw("*", callback)
  }

  /**
   * Publish a debug checkpoint event to global subscribers only.
   * Safe to call before Instance is initialized (bypasses instance-scoped dispatch).
   * Does NOT emit to GlobalBus/SSE — debug events stay backend-only.
   */
  export function debug(scope: string, message: string, data?: Record<string, unknown>) {
    const payload = {
      type: "debug.checkpoint" as const,
      properties: { scope, message, data },
    }
    for (const key of ["debug.checkpoint", "*"]) {
      const match = globalSubscriptions.get(key)
      for (const sub of match ?? []) {
        sub(payload)
      }
    }
  }

  /**
   * Register a global (non-instance) subscriber with logLevel gate.
   * Global subscribers persist across instance lifecycles.
   * The callback is only invoked when getLogLevel() >= minLevel.
   */
  export function subscribeGlobal(
    type: string | "*",
    minLevel: LogLevel,
    callback: Subscription,
  ) {
    const gated: Subscription = (event) => {
      if (getLogLevel() < minLevel) return
      return callback(event)
    }
    let match = globalSubscriptions.get(type) ?? []
    match.push(gated)
    globalSubscriptions.set(type, match)

    return () => {
      const match = globalSubscriptions.get(type)
      if (!match) return
      const index = match.indexOf(gated)
      if (index === -1) return
      match.splice(index, 1)
    }
  }

  function raw(type: string, callback: (event: any) => void) {
    const subscriptions = state().subscriptions
    let match = subscriptions.get(type) ?? []
    match.push(callback)
    subscriptions.set(type, match)

    return () => {
      const match = subscriptions.get(type)
      if (!match) return
      const index = match.indexOf(callback)
      if (index === -1) return
      match.splice(index, 1)
    }
  }
}

// Wire sink → Bus.debug at module init (after namespace is defined).
// sink.ts has zero project deps, so this never creates a circular import.
setDebugHandler(Bus.debug)
