#!/usr/bin/env bun
/**
 * migrate-disabled-providers.ts
 *
 * One-shot migration for plans/config-restructure Phase 2.
 *
 * Before: operators hand-maintained a `disabled_providers` list (109 entries
 * in the incident case) inside ~/.config/opencode/opencode.json to hide
 * providers they did not have accounts for.
 *
 * After: provider availability is derived from ~/.config/opencode/accounts.json.
 * A provider with no accounts is automatically hidden — the `disabled_providers`
 * entry is redundant. `disabled_providers` still matters for operators who DO
 * have accounts for a provider but choose to suppress it.
 *
 * This script diffs the two files and tells you which `disabled_providers`
 * entries are redundant (safe to drop) and which represent real overrides that
 * must be kept. It never modifies anything in --dry-run mode.
 *
 * Usage:
 *   bun run scripts/migrate-disabled-providers.ts --dry-run
 *   bun run scripts/migrate-disabled-providers.ts --apply
 */

import fs from "fs/promises"
import path from "path"
import os from "os"
import { parse as parseJsonc, applyEdits, modify } from "jsonc-parser"

const CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
const STATE_HOME = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state")
const OPENCODE_CONFIG = path.join(CONFIG_HOME, "opencode", "opencode.json")
const OPENCODE_CONFIG_JSONC = path.join(CONFIG_HOME, "opencode", "opencode.jsonc")
const ACCOUNTS = path.join(CONFIG_HOME, "opencode", "accounts.json")

type AccountsFile = {
  families?: Record<string, { accounts?: Record<string, unknown> }>
}

async function readJsonc<T>(filepath: string): Promise<{ text: string; data: T } | undefined> {
  try {
    const text = await Bun.file(filepath).text()
    const data = parseJsonc(text, undefined as any, { allowTrailingComma: true }) as T
    return { text, data }
  } catch (err: any) {
    if (err?.code === "ENOENT") return
    throw err
  }
}

function providersWithAccounts(accounts: AccountsFile | undefined): Set<string> {
  const result = new Set<string>()
  if (!accounts?.families) return result
  for (const [providerId, data] of Object.entries(accounts.families)) {
    if (data?.accounts && Object.keys(data.accounts).length > 0) {
      result.add(providerId)
    }
  }
  return result
}

function formatSet(set: Set<string>): string {
  return [...set].sort().join(", ") || "(none)"
}

async function main() {
  const mode = process.argv.includes("--apply") ? "apply" : "dry-run"
  const verbose = process.argv.includes("--verbose")

  console.log(`# migrate-disabled-providers (${mode})`)
  console.log(`# config dir:  ${CONFIG_HOME}/opencode`)
  console.log(`# state dir:   ${STATE_HOME}/opencode`)
  console.log("")

  // Prefer opencode.json over opencode.jsonc when both exist (runtime does
  // the same via loadFile iteration order, last merged wins).
  let configPath = OPENCODE_CONFIG
  let config = await readJsonc<Record<string, unknown>>(OPENCODE_CONFIG)
  if (!config) {
    configPath = OPENCODE_CONFIG_JSONC
    config = await readJsonc<Record<string, unknown>>(OPENCODE_CONFIG_JSONC)
  }
  if (!config) {
    console.error(`error: ${OPENCODE_CONFIG} (or .jsonc) not found. Nothing to migrate.`)
    process.exit(2)
  }

  const accounts = (await readJsonc<AccountsFile>(ACCOUNTS))?.data
  const hasAccount = providersWithAccounts(accounts)

  const disabled: string[] = Array.isArray(config.data?.disabled_providers)
    ? ([...(config.data.disabled_providers as string[])] as string[])
    : []
  if (disabled.length === 0) {
    console.log("No `disabled_providers` entries found. Nothing to migrate.")
    return
  }

  const redundant = disabled.filter((id) => !hasAccount.has(id))
  const keep = disabled.filter((id) => hasAccount.has(id))

  console.log(`disabled_providers: ${disabled.length} entries`)
  console.log(`providers with accounts: ${hasAccount.size}`)
  console.log("")
  console.log(`redundant (no account anyway — safe to drop): ${redundant.length}`)
  if (verbose || redundant.length <= 20) {
    console.log(`  ${formatSet(new Set(redundant))}`)
  }
  console.log("")
  console.log(`real override (has account but user wants it disabled): ${keep.length}`)
  console.log(`  ${formatSet(new Set(keep))}`)
  console.log("")

  if (mode === "dry-run") {
    console.log("Dry run — no changes written. Re-run with --apply to drop the redundant entries.")
    return
  }

  if (redundant.length === 0) {
    console.log("Nothing redundant to drop. Exiting without changes.")
    return
  }

  const backupPath = `${configPath}.pre-disabled-providers-migration.bak`
  await fs.copyFile(configPath, backupPath)
  console.log(`Backup written: ${backupPath}`)

  const nextDisabled = keep.length > 0 ? keep : undefined
  let updatedText: string
  if (configPath.endsWith(".jsonc")) {
    // Preserve comments when rewriting .jsonc
    updatedText = applyEdits(
      config.text,
      modify(config.text, ["disabled_providers"], nextDisabled, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    )
  } else {
    const parsed = JSON.parse(config.text)
    if (nextDisabled) parsed.disabled_providers = nextDisabled
    else delete parsed.disabled_providers
    updatedText = JSON.stringify(parsed, null, 2) + "\n"
  }

  await Bun.write(configPath, updatedText)
  console.log(`Updated ${configPath}`)
  console.log(`  removed ${redundant.length} redundant entries, kept ${keep.length} override entries`)
}

await main()
