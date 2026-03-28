/**
 * codex-native.ts — Bun FFI binding for libcodex_provider
 *
 * Provides TypeScript wrappers around the C shared library's exported functions.
 * The C library handles: auth lifecycle, token management, client signature,
 * credential storage, and wire protocol details.
 *
 * This module bridges between the C plugin and opencode's provider system.
 */

import { dlopen, FFIType, suffix, ptr, toBuffer, CString } from "bun:ffi"
import { Log } from "../util/log"
import path from "path"
import fs from "fs"

const log = Log.create({ service: "codex-native" })

// --------------------------------------------------------------------------
// Library loading
// --------------------------------------------------------------------------

const LIB_NAMES = [
  `codex_provider.${suffix}`,
  `libcodex_provider.${suffix}`,
  `codex_provider.so`,
  `codex_provider.so.1`,
]

const SEARCH_PATHS = [
  // Relative to this package
  path.join(import.meta.dir, "../../../opencode-codex-provider/build"),
  // System paths
  "/usr/local/lib",
  "/usr/lib",
  // Home-local
  path.join(process.env.HOME ?? "", ".local/lib"),
]

function findLibrary(): string | null {
  for (const dir of SEARCH_PATHS) {
    for (const name of LIB_NAMES) {
      const p = path.join(dir, name)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

// --------------------------------------------------------------------------
// FFI symbols definition
// --------------------------------------------------------------------------

const symbols = {
  codex_init: {
    args: [FFIType.ptr], // const codex_config_t*
    returns: FFIType.i32,
  },
  codex_shutdown: {
    args: [],
    returns: FFIType.void,
  },
  codex_abi_version: {
    args: [],
    returns: FFIType.i32,
  },
  codex_get_originator: {
    args: [],
    returns: FFIType.ptr, // const char*
  },
  codex_login_apikey: {
    args: [FFIType.ptr], // const char* api_key
    returns: FFIType.i32,
  },
  codex_get_auth_status: {
    args: [FFIType.ptr], // codex_auth_status_t* out
    returns: FFIType.i32,
  },
  codex_refresh_token: {
    args: [],
    returns: FFIType.i32,
  },
  codex_logout: {
    args: [],
    returns: FFIType.i32,
  },
  codex_get_models: {
    args: [FFIType.ptr, FFIType.ptr], // codex_model_t* models, int* count
    returns: FFIType.i32,
  },
  codex_get_quota: {
    args: [FFIType.ptr], // codex_quota_t* out
    returns: FFIType.i32,
  },
  codex_strerror: {
    args: [FFIType.i32], // codex_error_t err
    returns: FFIType.ptr, // const char*
  },
} as const

// --------------------------------------------------------------------------
// Type definitions matching C structs
// --------------------------------------------------------------------------

export const enum CodexAuthMode {
  NONE = 0,
  CHATGPT = 1,
  API_KEY = 2,
  EXTERNAL = 3,
}

export const enum CodexPlanType {
  UNKNOWN = 0,
  FREE = 1,
  PLUS = 2,
  PRO = 3,
  TEAM = 4,
  BUSINESS = 5,
  ENTERPRISE = 6,
  EDU = 7,
}

export interface CodexAuthStatus {
  mode: CodexAuthMode
  planType: CodexPlanType
  authenticated: boolean
  stale: boolean
  email: string | null
  userId: string | null
  accountId: string | null
  accessToken: string | null
  lastRefreshEpoch: number
}

export interface CodexModel {
  id: string
  name: string
  family: string
  reasoning: boolean
  toolcall: boolean
  imageInput: boolean
  contextWindow: number
  maxOutput: number
  costInput: number
  costOutput: number
  costReasoning: number
  status: string
}

export interface CodexQuota {
  planType: CodexPlanType
  primaryUsedPct: number
  primaryWindowSec: number
  primaryResetAt: number
  secondaryUsedPct: number
  secondaryWindowSec: number
  secondaryResetAt: number
  hasCredits: boolean
  unlimited: boolean
  creditBalance: number
}

// --------------------------------------------------------------------------
// Native library wrapper
// --------------------------------------------------------------------------

let lib: ReturnType<typeof dlopen<typeof symbols>> | null = null
let initialized = false

export namespace CodexNative {
  /**
   * Load the C shared library. Returns false if not found.
   */
  export function load(): boolean {
    if (lib) return true

    const libPath = findLibrary()
    if (!libPath) {
      log.warn("codex_provider library not found", {
        searchPaths: SEARCH_PATHS,
      })
      return false
    }

    try {
      lib = dlopen(libPath, symbols)
      log.info("loaded codex_provider", { path: libPath })

      // Verify ABI version
      const version = lib.symbols.codex_abi_version()
      if (version !== 1) {
        log.error("codex_provider ABI version mismatch", {
          expected: 1,
          got: version,
        })
        lib = null
        return false
      }

      return true
    } catch (err) {
      log.error("failed to load codex_provider", { path: libPath, error: err })
      return false
    }
  }

  /**
   * Initialize the plugin with default config.
   * Call after load().
   */
  export function init(): number {
    if (!lib) return -2 // CODEX_ERR_NOT_INITIALIZED
    if (initialized) return 0

    // Pass NULL config → all defaults
    const rc = lib.symbols.codex_init(null)
    if (rc === 0) initialized = true
    return rc
  }

  /**
   * Shut down and free resources.
   */
  export function shutdown(): void {
    if (!lib || !initialized) return
    lib.symbols.codex_shutdown()
    initialized = false
  }

  /**
   * Set API key directly.
   */
  export function loginApiKey(key: string): number {
    if (!lib) return -2
    const buf = Buffer.from(key + "\0", "utf-8")
    return lib.symbols.codex_login_apikey(ptr(buf))
  }

  /**
   * Trigger token refresh if stale.
   */
  export function refreshToken(): number {
    if (!lib) return -2
    return lib.symbols.codex_refresh_token()
  }

  /**
   * Log out and clear credentials.
   */
  export function logout(): number {
    if (!lib) return -2
    return lib.symbols.codex_logout()
  }

  /**
   * Get the originator string (for HTTP headers).
   */
  export function getOriginator(): string | null {
    if (!lib) return null
    const p = lib.symbols.codex_get_originator()
    if (!p) return null
    return new CString(p)
  }

  /**
   * Get auth status. Returns null if not initialized.
   */
  export function getAuthStatus(): CodexAuthStatus | null {
    if (!lib) return null

    // Allocate buffer for codex_auth_status_t
    // Layout: mode(i32) + plan_type(i32) + authenticated(i32) + stale(i32)
    //         + email(ptr) + user_id(ptr) + account_id(ptr) + access_token(ptr)
    //         + last_refresh_epoch(i64)
    // Total: 4*4 + 4*8 + 8 = 56 bytes (with alignment)
    const buf = new ArrayBuffer(128) // generous
    const view = new DataView(buf)
    const bufPtr = ptr(new Uint8Array(buf))

    const rc = lib.symbols.codex_get_auth_status(bufPtr)
    if (rc !== 0) return null

    const ptrSize = 8 // 64-bit
    const readCString = (offset: number): string | null => {
      const p = view.getBigUint64(offset, true)
      if (p === 0n) return null
      return new CString(Number(p))
    }

    return {
      mode: view.getInt32(0, true),
      planType: view.getInt32(4, true),
      authenticated: view.getInt32(8, true) !== 0,
      stale: view.getInt32(12, true) !== 0,
      email: readCString(16),
      userId: readCString(16 + ptrSize),
      accountId: readCString(16 + 2 * ptrSize),
      accessToken: readCString(16 + 3 * ptrSize),
      lastRefreshEpoch: Number(view.getBigInt64(16 + 4 * ptrSize, true)),
    }
  }

  /**
   * Get human-readable error message.
   */
  export function strerror(code: number): string {
    if (!lib) return "library not loaded"
    const p = lib.symbols.codex_strerror(code)
    if (!p) return "unknown error"
    return new CString(p)
  }

  /**
   * Check if the native library is loaded and initialized.
   */
  export function isAvailable(): boolean {
    return lib !== null && initialized
  }
}
