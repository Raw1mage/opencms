import { BusEvent } from "@/bus/bus-event"
import z from "zod"

export const Event = {
  Connected: BusEvent.define("server.connected", z.object({})),
  Disposed: BusEvent.define("global.disposed", z.object({})),
  KillSwitchChanged: BusEvent.define(
    "killswitch.status.changed",
    z.object({
      active: z.boolean(),
      state: z.string(),
      requestID: z.string().optional(),
      initiator: z.string().optional(),
      reason: z.string().optional(),
      snapshotURL: z.string().nullable().optional(),
    }),
  ),
}
