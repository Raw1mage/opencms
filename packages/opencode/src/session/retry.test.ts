import { describe, expect, it } from "bun:test"
import { SessionRetry } from "./retry"
import { MessageV2 } from "./message-v2"

describe("SessionRetry.retryable", () => {
  it("does not retry context overflow errors", () => {
    const error = new MessageV2.ContextOverflowError({
      message: "context window exceeded",
    }).toObject()

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  it("returns retry message for retryable API errors", () => {
    const error = new MessageV2.APIError({
      message: "Provider Overloaded",
      isRetryable: true,
    }).toObject()

    expect(SessionRetry.retryable(error)).toBe("Provider is overloaded")
  })
})
