/**
 * Registry-boundary errors and shape guard for provider-account-decoupling.
 *
 * The (provider, account, model) tuple has three independent dimensions.
 * Provider identity in the registry MUST be a family — never a per-account
 * synthetic id like `codex-subscription-<slug>`. This module defines the
 * errors thrown when callers violate that invariant, plus the `assertFamilyKey`
 * helper used at every registry write boundary.
 *
 * Spec: specs/provider-account-decoupling/
 *   - DD-1 (registry key is family)
 *   - DD-2 (Auth.get is two-arg)
 *   - DD-6 (boot guard fails loud without migration marker)
 *   - DD-8 (no compatibility shims)
 */

import { NamedError } from "@opencode-ai/util/error"
import z from "zod"

/**
 * Thrown when a non-family providerId is inserted into the providers map.
 * Caught by `assertFamilyKey` at the registry write boundary.
 */
export const RegistryShapeError = NamedError.create(
  "RegistryShapeError",
  z.object({
    providerId: z.string(),
    knownFamilies: z.array(z.string()),
    message: z.string(),
  }),
)

/**
 * Thrown by Auth.get / getSDK when called with a family that is not in
 * Account.knownFamilies(). Indicates a caller is passing accountId where
 * family was expected.
 */
export const UnknownFamilyError = NamedError.create(
  "UnknownFamilyError",
  z.object({
    family: z.string(),
    knownFamilies: z.array(z.string()),
    message: z.string(),
  }),
)

/**
 * Thrown by Auth.get(family) when accountId is omitted AND the family has
 * no `activeAccount` set. Operator must pick an active account via the
 * admin panel; AI agents must pass accountId explicitly from session-pinned
 * identity.
 */
export const NoActiveAccountError = NamedError.create(
  "NoActiveAccountError",
  z.object({
    family: z.string(),
    message: z.string(),
  }),
)

/**
 * Thrown at daemon boot when `.migration-state.json` is missing or its
 * version does not match the binary's expected migration version. Operator
 * must run the migration script before restarting the daemon.
 *
 * Per AGENTS.md rule 1, no silent fallback: daemon exits with code 1.
 */
export const MigrationRequiredError = NamedError.create(
  "MigrationRequiredError",
  z.object({
    expectedVersion: z.string(),
    found: z.string().nullable(),
    markerPath: z.string(),
    message: z.string(),
  }),
)

/**
 * Assert that `providerId` is a registered family. Call this at every
 * `providers[X] = ...` write site in the provider registry.
 *
 * Throws `RegistryShapeError` on miss — no silent fallback, no resolution
 * attempt via parseProvider.
 */
export function assertFamilyKey(providerId: string, knownFamilies: readonly string[]): void {
  if (!providerId) {
    throw new RegistryShapeError({
      providerId,
      knownFamilies: [...knownFamilies],
      message: "providers[] insertion rejected: providerId is empty",
    })
  }
  if (!knownFamilies.includes(providerId)) {
    throw new RegistryShapeError({
      providerId,
      knownFamilies: [...knownFamilies],
      message:
        `providers[${JSON.stringify(providerId)}] insertion rejected: ` +
        `not a known family. knownFamilies=${JSON.stringify([...knownFamilies])}. ` +
        `If you have an accountId here, pass it as a separate dimension instead of ` +
        `encoding it into the providerId.`,
    })
  }
}
