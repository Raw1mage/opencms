import { describe, expect, test } from "bun:test"
import { formatRestartErrorResponse } from "./restart-errors"

describe("formatRestartErrorResponse", () => {
  test("formats structured restart payloads", () => {
    const raw = JSON.stringify({
      code: "WEB_RESTART_FAILED",
      message: "vite build failed",
      hint: "Current runtime appears to be webctl/dev mode; restart may rebuild frontend before restarting. See the restart error log for full output.",
      txid: "web-123",
      errorLogPath: "/tmp/opencode-web-restart-web-123.error.log",
    })

    expect(formatRestartErrorResponse(raw, 500)).toBe(
      [
        "vite build failed",
        "Current runtime appears to be webctl/dev mode; restart may rebuild frontend before restarting. See the restart error log for full output.",
        "Restart TX: web-123",
        "Error log: /tmp/opencode-web-restart-web-123.error.log",
      ].join("\n\n"),
    )
  })

  test("falls back to status when body is empty", () => {
    expect(formatRestartErrorResponse("", 500)).toBe("Restart failed (500)")
  })
})
