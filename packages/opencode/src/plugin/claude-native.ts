import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { CString, FFIType, dlopen, ptr, suffix } from "bun:ffi"
import path from "node:path"
import fs from "node:fs"
import { Log } from "../util/log"
import { ClaudeCliPlugin } from "./claude-cli"

const log = Log.create({ service: "plugin.claude-native" })

type ClaudeOAuthAuth = {
  type: "oauth" | "subscription"
  refresh: string
  access?: string
  expires?: number
  orgID?: string
  email?: string
}

type ClaudeApiAuth = {
  type: "api"
  key: string
}

function isClaudeOAuthAuth(value: unknown): value is ClaudeOAuthAuth {
  if (!value || typeof value !== "object") return false
  const type = (value as { type?: unknown }).type
  return type === "oauth" || type === "subscription"
}

function isClaudeApiAuth(value: unknown): value is ClaudeApiAuth {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "api"
}

const symbols = {
  claude_init: { args: [FFIType.ptr], returns: FFIType.i32 },
  claude_shutdown: { args: [], returns: FFIType.void },
  claude_abi_version: { args: [], returns: FFIType.i32 },
  claude_get_originator: { args: [], returns: FFIType.ptr },
  claude_set_oauth_tokens: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  claude_set_api_key: { args: [FFIType.ptr], returns: FFIType.i32 },
  claude_get_auth_status: { args: [FFIType.ptr], returns: FFIType.i32 },
  claude_strerror: { args: [FFIType.i32], returns: FFIType.ptr },
} as const

const SEARCH_PATHS = [
  path.join(import.meta.dir, "../../../provider-claude/build"),
  "/usr/local/lib",
  "/usr/lib",
  path.join(process.env.HOME ?? "", ".local/lib"),
]

const LIB_NAMES = [
  `claude_provider.${suffix}`,
  `libclaude_provider.${suffix}`,
  "claude_provider.so",
  "claude_provider.so.1",
]

type ClaudeLib = ReturnType<typeof dlopen<typeof symbols>>

let library: ClaudeLib | null = null
let initialized = false

function toCString(value?: string) {
  return Buffer.from(`${value ?? ""}\0`, "utf8")
}

function readCString(pointer: number | bigint | null | undefined): string | null {
  if (!pointer || pointer === 0 || pointer === BigInt(0)) return null
  return new CString(pointer as unknown as ReturnType<typeof ptr>).toString()
}

function findLibrary() {
  for (const dir of SEARCH_PATHS) {
    for (const name of LIB_NAMES) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

function strerror(code: number) {
  if (!library) return `error ${code}`
  return readCString(library.symbols.claude_strerror(code)) ?? `error ${code}`
}

function loadLibrary() {
  if (library) return library
  const libraryPath = findLibrary()
  if (!libraryPath) return null
  const loaded = dlopen(libraryPath, symbols)
  if (loaded.symbols.claude_abi_version() !== 1) {
    ;(loaded as { close?: () => void }).close?.()
    return null
  }
  library = loaded
  return library
}

function ensureInitialized() {
  const loaded = loadLibrary()
  if (!loaded) return false
  if (initialized) return true
  const rc = loaded.symbols.claude_init(null)
  if (rc !== 0) {
    log.warn("claude-native init failed", { rc, reason: strerror(rc) })
    return false
  }
  initialized = true
  return true
}

function seedOAuth(auth: ClaudeOAuthAuth) {
  if (!library) return false
  const refresh = toCString(auth.refresh)
  const access = toCString(auth.access)
  const email = toCString(auth.email)
  const orgID = toCString(auth.orgID)
  const rc = library.symbols.claude_set_oauth_tokens(
    ptr(refresh),
    ptr(access),
    BigInt(auth.expires ?? 0),
    ptr(email),
    ptr(orgID),
  )
  if (rc !== 0) {
    log.warn("claude-native oauth seed failed", { rc, reason: strerror(rc) })
    return false
  }
  return true
}

function seedApiKey(key: string) {
  if (!library) return false
  const value = toCString(key)
  const rc = library.symbols.claude_set_api_key(ptr(value))
  if (rc !== 0) {
    log.warn("claude-native api-key seed failed", { rc, reason: strerror(rc) })
    return false
  }
  return true
}

function getStatus() {
  if (!library) return null
  const buffer = new Uint8Array(64)
  const view = new DataView(buffer.buffer)
  const rc = library.symbols.claude_get_auth_status(ptr(buffer))
  if (rc !== 0) {
    log.warn("claude-native status failed", { rc, reason: strerror(rc) })
    return null
  }
  return {
    mode: view.getInt32(0, true),
    authenticated: view.getInt32(4, true) !== 0,
    stale: view.getInt32(8, true) !== 0,
    email: readCString(view.getBigUint64(16, true)),
    orgID: readCString(view.getBigUint64(24, true)),
    accessToken: readCString(view.getBigUint64(32, true)),
    expires: Number(view.getBigInt64(40, true)),
  }
}

export async function ClaudeNativeAuthPlugin(input: PluginInput): Promise<Hooks> {
  const baseHooks = await ClaudeCliPlugin(input)
  const baseLoader = baseHooks.auth?.loader
  if (!baseHooks.auth || !baseLoader) return baseHooks

  return {
    ...baseHooks,
    auth: {
      ...baseHooks.auth,
      async loader(getAuth, provider) {
        if (ensureInitialized()) {
          const auth = await getAuth().catch(() => undefined)
          if (isClaudeOAuthAuth(auth)) {
            seedOAuth(auth)
          } else if (isClaudeApiAuth(auth)) {
            seedApiKey(auth.key)
          }

          const status = getStatus()
          if (status) {
            log.info("claude-native bridge ready", {
              provider: provider.id,
              mode: status.mode,
              authenticated: status.authenticated,
              stale: status.stale,
              hasAccessToken: !!status.accessToken,
              originator: readCString(library?.symbols.claude_get_originator()),
            })
          }
        } else {
          log.info("claude-native unavailable; using claude-cli plugin transport path")
        }

        return baseLoader(getAuth, provider)
      },
    },
  }
}
