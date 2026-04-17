import { Account } from "../account"
import { Config } from "../config/config"
import { Log } from "../util/log"

/**
 * Phase 2 of plans/config-restructure: derive provider enabled/disabled from
 * accounts.json. Before, operators had to hand-maintain a 109-entry
 * `disabled_providers` denylist in opencode.json listing every provider they
 * did not have accounts for. That list was entirely redundant with
 * accounts.json — if there is no account, the provider cannot be used anyway.
 *
 * This module replaces the denylist as the primary gate. `disabled_providers`
 * is still honored as an explicit user override (Phase 3 will move it into
 * providers.json), so operators can still disable a provider they DO have
 * accounts for.
 */
export namespace ProviderAvailability {
  const log = Log.create({ service: "provider-availability" })

  export type Availability = "enabled" | "disabled" | "no-account"

  export type Snapshot = {
    /** Provider id -> availability */
    byProvider: Record<string, Availability>
    /** Providers explicitly disabled by user override */
    overrideDisabled: Set<string>
    /** Providers that have at least one account in accounts.json */
    hasAccount: Set<string>
  }

  /**
   * Build a snapshot covering every provider mentioned in either accounts.json
   * or the operator's disabled_providers override. Callers that need to check
   * arbitrary provider ids should use `availabilityFor(id, snapshot)` after
   * building the snapshot — that avoids one accounts.json read per check.
   */
  export async function snapshot(): Promise<Snapshot> {
    const [all, config] = await Promise.all([Account.listAll(), Config.get()])
    const override = new Set(config.disabled_providers ?? [])

    const hasAccount = new Set<string>()
    for (const [providerId, data] of Object.entries(all)) {
      if (data.accounts && Object.keys(data.accounts).length > 0) {
        hasAccount.add(providerId)
      }
    }

    const providerIds = new Set<string>([...hasAccount, ...override])
    const byProvider: Record<string, Availability> = {}
    for (const id of providerIds) {
      byProvider[id] = availabilityFor(id, { hasAccount, overrideDisabled: override, byProvider: {} })
    }

    // AGENTS.md rule #1: loudly surface why a provider is effectively
    // unavailable. Using log.info (not log.warn) — a provider that lacks an
    // account is not a failure, just a derived state the operator should be
    // able to see in the daemon log if they wonder why it is hidden.
    if (process.env.NODE_ENV !== "test") {
      const overrideList = [...override].filter((id) => hasAccount.has(id))
      const redundantOverride = [...override].filter((id) => !hasAccount.has(id))
      if (overrideList.length) {
        log.info("disabled_providers override applied", { providers: overrideList })
      }
      if (redundantOverride.length) {
        log.info(
          "disabled_providers entries are redundant (no accounts anyway) — consider removing via scripts/migrate-disabled-providers.ts",
          { count: redundantOverride.length },
        )
      }
    }

    return { byProvider, overrideDisabled: override, hasAccount }
  }

  /**
   * Decide availability for a single provider against a prepared snapshot or
   * the shorthand { hasAccount, overrideDisabled } subset.
   */
  export function availabilityFor(
    providerId: string,
    context: Pick<Snapshot, "hasAccount" | "overrideDisabled">,
  ): Availability {
    if (context.overrideDisabled.has(providerId)) return "disabled"
    if (context.hasAccount.has(providerId)) return "enabled"
    return "no-account"
  }

  /**
   * Convenience: true if the provider should appear in the catalog. Treat
   * both "disabled" (user override) and "no-account" (nothing to auth with)
   * as not-shown. Callers that need the distinction should call
   * `availabilityFor()` directly.
   */
  export function isAllowed(providerId: string, context: Pick<Snapshot, "hasAccount" | "overrideDisabled">): boolean {
    return availabilityFor(providerId, context) === "enabled"
  }
}
