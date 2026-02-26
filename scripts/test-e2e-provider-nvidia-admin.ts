#!/usr/bin/env bun

/**
 * E2E tester: admin-like NVIDIA provider flow
 *
 * Simulates the critical runtime path:
 * 1) models.dev contains NVIDIA provider
 * 2) add NVIDIA API account (admin-equivalent Account.add flow)
 * 3) activate account
 * 4) verify provider model list is visible/resolvable
 */

import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { Instance } from "../packages/opencode/src/project/instance"
import { ModelsDev } from "../packages/opencode/src/provider/models"
import { Account } from "../packages/opencode/src/account"
import { Provider } from "../packages/opencode/src/provider/provider"

function fail(message: string): never {
  console.error(`❌ ${message}`)
  process.exit(1)
}

async function main() {
  console.log("=== E2E: Admin NVIDIA Provider Flow ===")

  const tmp = path.join(os.tmpdir(), `opencode-e2e-nvidia-${Date.now().toString(36)}`)
  await fs.mkdir(tmp, { recursive: true })
  await Bun.write(
    path.join(tmp, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
    }),
  )

  await Instance.provide({
    directory: tmp,
    fn: async () => {
      const models = await ModelsDev.get()
      const nvidia = models["nvidia"]
      if (!nvidia) fail("models.dev snapshot does not contain provider 'nvidia'")

      console.log(`✓ models.dev nvidia loaded (${Object.keys(nvidia.models ?? {}).length} models)`)

      const accountId = Account.generateId("nvidia", "api", "e2e")
      await Account.add("nvidia", accountId, {
        type: "api",
        name: "e2e",
        apiKey: "nvidia-e2e-key",
        addedAt: Date.now(),
      })
      await Account.setActive("nvidia", accountId)

      console.log(`✓ account added + active (${accountId})`)

      const providers = await Provider.list()
      const familyProvider = providers["nvidia"]
      if (!familyProvider) fail("Provider.list() missing 'nvidia' after account add")

      const familyModels = Object.keys(familyProvider.models)
      if (familyModels.length === 0) fail("nvidia provider has zero models after account add")

      const selectedModel = familyModels.includes("moonshotai/kimi-k2.5") ? "moonshotai/kimi-k2.5" : familyModels[0]

      const model = await Provider.getModel("nvidia", selectedModel)
      if (!model?.id) fail(`Provider.getModel failed for nvidia/${selectedModel}`)

      console.log(`✓ model list visible (${familyModels.length})`)
      console.log(`✓ model resolvable (nvidia/${model.id})`)
      console.log("✅ PASS")
    },
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
