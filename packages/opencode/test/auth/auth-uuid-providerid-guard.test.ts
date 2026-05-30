/**
 * auth-uuid-providerid-guard.test.ts
 *
 * Phase 4 (V4-3 / AC-5, requirement R-C2 / TV-C2) regression test for spec
 * `auth_credential-token-refresh-ineffective`.
 *
 * Non-regression guard: the invalid_grant fix must NOT weaken the existing L1
 * guard at auth/index.ts:212 that rejects a UUID-shaped providerId. A UUID there
 * is a JWT chatgpt_account_id leaking into Auth.set (legacy onTokenRefresh path),
 * which once materialized a phantom UUID-keyed family. Token rotation must go
 * through Account.update with the canonical family + opencode account id instead.
 *
 * The guard throws BEFORE `await import("../account")`, so the reject path does
 * no storage IO. We still wrap calls in Instance.provide + tmpdir so the
 * non-UUID control case (which DOES touch Account storage) cannot pollute the
 * real ~/.config/opencode (per opencms AGENTS.md test-hygiene rule).
 *
 * Evidence:
 *   packages/opencode/src/auth/index.ts:212  if (JWT.isUUID(providerId)) throw ...
 *   packages/opencode/src/util/jwt.ts:38      isUUID = /^8-4-4-4-12 hex$/i
 */
import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Auth } from "../../src/auth"

describe("auth UUID-providerId L1 guard (R-C2 / TV-C2)", () => {
  test("rejects a UUID-shaped providerId (JWT account id leak) with a clear error", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const uuid = "9f012c38-1a2b-4c3d-8e4f-0123456789ab"
        await expect(
          Auth.set(uuid, {
            type: "oauth",
            refresh: "rt",
            access: "at",
            expires: Date.now() + 3_600_000,
          } as Parameters<typeof Auth.set>[1]),
        ).rejects.toThrow(/UUID/)
      },
    })
  })

  test("does NOT reject a canonical family providerId (control — guard is UUID-specific)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // A canonical family id passes the L1 guard and reaches normal account
        // creation. We only assert it does NOT throw the UUID-guard error.
        const id = await Auth.set("nvidia-control", { type: "api", key: "nv-key-control" })
        expect(typeof id === "string" || id === undefined).toBe(true)
      },
    })
  })
})
