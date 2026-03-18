import z from "zod"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { BusEvent } from "./bus-event"
import { GlobalBus } from "./global"
import type { BusContext } from "./bus-context"

export type { BusContext } from "./bus-context"

export namespace Bus {
  const log = Log.create({ service: "bus" })
  type Subscription = (event: any) => void

  export const InstanceDisposed = BusEvent.define(
    "server.instance.disposed",
    z.object({
      directory: z.string(),
    }),
  )

  const state = Instance.state(
    () => {
      const subscriptions = new Map<any, Subscription[]>()

      return {
        subscriptions,
      }
    },
    async (_entry) => {
      // Instance disposal event is now published via Bus.publish in Instance.dispose().
      // No duplicate dispatch needed here.
    },
  )

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
    log.info("publishing", {
      type: def.type,
    })
    const pending = []
    const envelope = { ...payload, context: ctx }
    for (const key of [def.type, "*"]) {
      const match = state().subscriptions.get(key)
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

  function raw(type: string, callback: (event: any) => void) {
    log.info("subscribing", { type })
    const subscriptions = state().subscriptions
    let match = subscriptions.get(type) ?? []
    match.push(callback)
    subscriptions.set(type, match)

    return () => {
      log.info("unsubscribing", { type })
      const match = subscriptions.get(type)
      if (!match) return
      const index = match.indexOf(callback)
      if (index === -1) return
      match.splice(index, 1)
    }
  }
}
