/**
 * Circuit breaker for copilot-cli provider (DD-3: independent utility).
 *
 * State machine: CLOSED → OPEN (≥threshold failures) → HALF_OPEN (after reset timeout) → CLOSED/OPEN
 * Aligned with CLI binary params: 5 failures, 30s reset, [500,502,503,504].
 */

import { Log } from "../../util/log"
import { DEFAULT_CIRCUIT_BREAKER_CONFIG, type CircuitBreakerConfig } from "./types"

const log = Log.create({ service: "copilot-cli.circuit-breaker" })

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

export class CircuitBreaker {
  private state: CircuitState = "CLOSED"
  private failureCount = 0
  private lastFailureTime = 0
  private probeInFlight = false
  private probeStartTime = 0
  private currentResetTimeoutMs: number
  private readonly config: CircuitBreakerConfig

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config }
    this.currentResetTimeoutMs = this.config.resetTimeoutMs
  }

  getState(): CircuitState {
    this.updateState()
    return this.state
  }

  canRequest(): boolean {
    this.updateState()
    switch (this.state) {
      case "CLOSED":
        return true
      case "HALF_OPEN":
        // Allow one probe; block others until probe resolves
        if (this.probeInFlight && Date.now() - this.probeStartTime >= this.config.probeTimeoutMs) {
          this.probeInFlight = false
        }
        if (this.probeInFlight) return false
        this.probeInFlight = true
        this.probeStartTime = Date.now()
        return true
      case "OPEN":
        return false
    }
  }

  recordSuccess(): void {
    this.failureCount = 0
    this.probeInFlight = false
    this.currentResetTimeoutMs = this.config.resetTimeoutMs
    if (this.state !== "CLOSED") {
      log.info("circuit breaker closed", { previousState: this.state })
    }
    this.state = "CLOSED"
  }

  recordFailure(): void {
    const wasHalfOpen = this.state === "HALF_OPEN"
    this.failureCount++
    this.lastFailureTime = Date.now()
    this.probeInFlight = false

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = "OPEN"
      log.warn("circuit breaker opened", {
        failureCount: this.failureCount,
        resetTimeoutMs: this.currentResetTimeoutMs,
      })
    }

    // Double reset timeout on repeated HALF_OPEN failures (exponential backoff)
    if (wasHalfOpen && this.state === "OPEN") {
      this.currentResetTimeoutMs = Math.min(this.currentResetTimeoutMs * 2, this.config.resetTimeoutMs * 4)
    }
  }

  /** Record a response status code. Returns true if it counted as a failure. */
  recordResponse(statusCode: number): boolean {
    if (this.config.statusCodes.includes(statusCode)) {
      this.recordFailure()
      return true
    }
    this.recordSuccess()
    return false
  }

  private updateState(): void {
    if (this.state === "OPEN" && Date.now() - this.lastFailureTime >= this.currentResetTimeoutMs) {
      log.info("circuit breaker half-open", { elapsedMs: Date.now() - this.lastFailureTime })
      this.state = "HALF_OPEN"
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton for the copilot-cli provider
// ---------------------------------------------------------------------------

let _instance: CircuitBreaker | null = null

export function getCircuitBreaker(): CircuitBreaker {
  if (!_instance) {
    _instance = new CircuitBreaker()
  }
  return _instance
}
