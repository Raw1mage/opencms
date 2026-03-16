import express from "express"
import { createSnapshot } from "../../server/services/snapshot_service"
import { publishControl } from "../../server/control/control_channel"
import { writeAudit } from "../../server/services/audit_service"
import { generateMfaCode, verifyMfaCode } from "../../server/services/mfa_service"

const router = express.Router()

// POST /admin/kill-switch/trigger
router.post("/trigger", async (req, res) => {
  const { initiator, reason, mode = "global", mfa_code } = req.body
  const request_id = req.body.request_id || `ks-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  // MFA flow
  if (!mfa_code) {
    // generate and send (dev: return code in response)
    try {
      const code = await generateMfaCode(initiator || "unknown")
      await writeAudit({ request_id, initiator, action: "kill_switch.mfa_challenge_generated", meta: { mode, reason } })
      res.status(202).json({ mfa_required: true, message: "MFA code sent", dev_code: code })
      return
    } catch (e) {
      await writeAudit({ request_id, initiator, action: "kill_switch.mfa_generate_failed", reason: e.message })
      res.status(500).json({ ok: false, error: "mfa_generate_failed", message: e.message })
      return
    }
  }

  // verify provided code
  const ok = await verifyMfaCode(initiator || "unknown", String(mfa_code))
  if (!ok) {
    await writeAudit({ request_id, initiator, action: "kill_switch.mfa_failed", reason: "invalid_code" })
    res.status(401).json({ ok: false, error: "mfa_invalid" })
    return
  }

  // proceed with snapshot + control publish
  await writeAudit({ request_id, initiator, action: "kill_switch.mfa_verified" })

  // create snapshot (async)
  const snapshot_url = await createSnapshot({ initiator, reason, mode, request_id })
  await writeAudit({ request_id, initiator, action: "kill_switch.trigger", reason, mode, snapshot_url })
  // publish a control message to all workers
  const seq = Date.now()
  try {
    await publishControl({ request_id, action: "cancel", seq, initiator }, 5000)
    res.json({ ok: true, request_id, snapshot_url })
  } catch (e) {
    // timeout -> write audit and respond
    await writeAudit({ request_id, initiator, action: "kill_switch.trigger_failed", reason: e.message })
    res.status(504).json({ ok: false, error: "worker ack timeout", message: e.message })
  }
})

export default router
