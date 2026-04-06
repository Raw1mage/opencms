import fs from "fs/promises"
import path from "path"
import z from "zod/v4"
import { NamedError } from "@opencode-ai/util/error"
import { Auth } from "@/auth"
import { Account } from "@/account"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { manifest as gmailManifest } from "./apps/gmail/manifest"
import { manifest as googleCalendarManifest } from "./apps/google-calendar/manifest"

export namespace ManagedAppRegistry {
  const log = Log.create({ service: "managed-app-registry" })
  const filepath = path.join(Global.Path.user, "managed-apps.json")
  const VERSION = 1 as const

  export const BuiltInAppSource = z.object({
    type: z.literal("builtin"),
    owner: z.literal("opencode"),
    package: z.string(),
    entrypoint: z.string(),
    localOnly: z.literal(true),
  })
  export type BuiltInAppSource = z.infer<typeof BuiltInAppSource>

  export const Capability = z.object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(["tool", "oauth", "resource", "service"]),
    description: z.string(),
    operations: z.array(z.enum(["list", "read", "create", "update", "delete", "query"])),
  })
  export type Capability = z.infer<typeof Capability>

  export const Permission = z.object({
    id: z.string(),
    label: z.string(),
    required: z.boolean(),
  })
  export type Permission = z.infer<typeof Permission>

  export const AuthOwnership = z.enum(["canonical-account"])
  export type AuthOwnership = z.infer<typeof AuthOwnership>

  export const AuthType = z.enum(["oauth"])
  export type AuthType = z.infer<typeof AuthType>

  export const AuthContract = z.object({
    providerKey: z.string(),
    ownership: AuthOwnership,
    type: AuthType,
    required: z.boolean(),
    allowImplicitActiveAccount: z.boolean(),
    scopes: z.array(z.string()),
  })
  export type AuthContract = z.infer<typeof AuthContract>

  export const ConfigField = z.object({
    key: z.string(),
    label: z.string(),
    required: z.boolean(),
    secret: z.boolean(),
  })
  export type ConfigField = z.infer<typeof ConfigField>

  export const ConfigContract = z.object({
    fields: z.array(ConfigField),
  })
  export type ConfigContract = z.infer<typeof ConfigContract>

  export const ToolArgument = z.object({
    name: z.string(),
    type: z.enum(["string", "string[]", "datetime", "datetime[]", "number", "boolean", "object"]),
    description: z.string(),
    required: z.boolean(),
  })
  export type ToolArgument = z.infer<typeof ToolArgument>

  export const ToolDescriptor = z.object({
    id: z.string(),
    label: z.string(),
    capabilityId: z.string(),
    description: z.string(),
    mutates: z.boolean(),
    requiresConfirmation: z.boolean(),
    arguments: z.array(ToolArgument),
  })
  export type ToolDescriptor = z.infer<typeof ToolDescriptor>

  export const ToolContract = z.object({
    namespace: z.string(),
    tools: z.array(ToolDescriptor),
  })
  export type ToolContract = z.infer<typeof ToolContract>

  export const AuthBindingStatus = z.enum(["not_required", "required", "authenticated", "invalid"])
  export type AuthBindingStatus = z.infer<typeof AuthBindingStatus>

  export const AuthBinding = z.object({
    providerKey: z.string(),
    accountId: z.string().optional(),
    status: AuthBindingStatus,
  })
  export type AuthBinding = z.infer<typeof AuthBinding>

  export const CatalogEntry = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    version: z.string(),
    source: BuiltInAppSource,
    capabilities: z.array(Capability),
    permissions: z.array(Permission),
    requiredConfig: z.array(z.string()),
    auth: AuthContract,
    configContract: ConfigContract,
    toolContract: ToolContract,
  })
  export type CatalogEntry = z.infer<typeof CatalogEntry>

  export const PersistedConfig = z.object({
    keys: z.array(z.string()),
    updatedAt: z.number(),
  })
  export type PersistedConfig = z.infer<typeof PersistedConfig>

  export const InstallState = z.enum(["available", "installing", "installed", "uninstalling"])
  export type InstallState = z.infer<typeof InstallState>

  export const EnableState = z.enum(["disabled", "enabled"])
  export type EnableState = z.infer<typeof EnableState>

  export const ConfigStatus = z.enum(["unknown", "required", "configured", "invalid"])
  export type ConfigStatus = z.infer<typeof ConfigStatus>

  export const ErrorStatus = z.object({
    code: z.string(),
    message: z.string(),
    ts: z.number(),
  })
  export type ErrorStatus = z.infer<typeof ErrorStatus>

  export const RuntimeStatus = z.enum([
    "ready",
    "disabled",
    "error",
    "pending_config",
    "pending_install",
    "pending_auth",
  ])
  export type RuntimeStatus = z.infer<typeof RuntimeStatus>

  export const OperatorInstallState = z.enum(["available", "installed"])
  export type OperatorInstallState = z.infer<typeof OperatorInstallState>

  export const OperatorConfigState = z.enum(["not_required", "required", "configured", "invalid"])
  export type OperatorConfigState = z.infer<typeof OperatorConfigState>

  export const OperatorAuthState = z.enum(["not_required", "required", "authenticated", "invalid"])
  export type OperatorAuthState = z.infer<typeof OperatorAuthState>

  export const OperatorRuntimeState = z.enum(["inactive", "ready", "error"])
  export type OperatorRuntimeState = z.infer<typeof OperatorRuntimeState>

  export const OperatorErrorState = z.enum(["none", "auth_required", "invalid_auth", "invalid_config", "runtime_error"])
  export type OperatorErrorState = z.infer<typeof OperatorErrorState>

  export const OperatorState = z.object({
    install: OperatorInstallState,
    auth: OperatorAuthState,
    config: OperatorConfigState,
    runtime: OperatorRuntimeState,
    error: OperatorErrorState,
  })
  export type OperatorState = z.infer<typeof OperatorState>

  export const UsageErrorReason = z.enum(["unauthenticated", "misconfigured", "runtime_error"])
  export type UsageErrorReason = z.infer<typeof UsageErrorReason>

  export const UsageError = z.object({
    appId: z.string(),
    status: RuntimeStatus,
    reason: UsageErrorReason,
    code: z.string(),
    message: z.string(),
  })
  export type UsageError = z.infer<typeof UsageError>

  export const AppNotFoundError = NamedError.create(
    "ManagedAppNotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  export const UsageStateError = NamedError.create("ManagedAppUsageStateError", UsageError)

  export const AppState = z.object({
    appId: z.string(),
    source: BuiltInAppSource,
    installState: InstallState,
    enableState: EnableState,
    configStatus: ConfigStatus,
    config: PersistedConfig.optional(),
    error: ErrorStatus.optional(),
    installedAt: z.number().optional(),
    updatedAt: z.number(),
  })
  export type AppState = z.infer<typeof AppState>

  export const RuntimeOwner = z.enum(["system", "session"])
  export type RuntimeOwner = z.infer<typeof RuntimeOwner>

  export const RuntimeAttachment = z.object({
    owner: RuntimeOwner,
    ownerId: z.string(),
    attachedAt: z.number(),
  })
  export type RuntimeAttachment = z.infer<typeof RuntimeAttachment>

  export const AppSnapshot = CatalogEntry.extend({
    state: AppState,
    authBinding: AuthBinding,
    runtimeStatus: RuntimeStatus,
    operator: OperatorState,
  })
  export type AppSnapshot = z.infer<typeof AppSnapshot>

  export const RuntimeSnapshot = z.object({
    appId: z.string(),
    status: RuntimeStatus,
    attachment: RuntimeAttachment.optional(),
  })
  export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshot>

  export const ManagedAppSnapshot = z.object({
    catalog: CatalogEntry,
    persisted: AppState,
    authBinding: AuthBinding,
    runtime: RuntimeSnapshot,
    operator: OperatorState,
  })
  export type ManagedAppSnapshot = z.infer<typeof ManagedAppSnapshot>

  export const ReadyToolBinding = z.object({
    appId: z.string(),
    namespace: z.string(),
    tool: ToolDescriptor,
  })
  export type ReadyToolBinding = z.infer<typeof ReadyToolBinding>

  export const Storage = z.object({
    version: z.literal(VERSION),
    apps: z.record(z.string(), AppState),
  })
  export type Storage = z.infer<typeof Storage>

  const runtimeAttachments = new Map<string, RuntimeAttachment>()

  export const Event = {
    Updated: BusEvent.define(
      "managed_app.updated",
      z.object({
        app: AppSnapshot,
      }),
    ),
  }

  // Catalog entries are now defined in each App's manifest.ts file,
  // imported above and assembled here. This eliminates the 500-line
  // hardcoded block that previously lived inline (mcp-separation Step 2).
  const BUILTIN_CATALOG: Record<string, CatalogEntry> = {
    "google-calendar": googleCalendarManifest,
    gmail: gmailManifest,
  }

  const GOOGLE_MANAGED_APP_IDS = ["gmail", "google-calendar"] as const

  let cache: Storage | undefined
  let mtime: number | undefined
  let mutex: Promise<void> = Promise.resolve()

  function withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const result = mutex.then(fn, fn)
    mutex = result.then(
      () => {},
      () => {},
    )
    return result
  }

  async function getDiskMtime(): Promise<number | undefined> {
    const file = Bun.file(filepath)
    if (!(await file.exists())) return undefined
    const value = file.lastModified
    return typeof value === "number" ? value : undefined
  }

  function defaultState(entry: CatalogEntry, now = Date.now()): AppState {
    return {
      appId: entry.id,
      source: entry.source,
      installState: "available",
      enableState: "disabled",
      configStatus: entry.requiredConfig.length > 0 ? "required" : "configured",
      updatedAt: now,
    }
  }

  function requireInstalledState(appId: string, entry: CatalogEntry, current: Storage): AppState {
    const stored = current.apps[appId] ?? defaultState(entry)
    if (stored.installState !== "installed") {
      throw new Error(`Managed app is not installed: ${appId}`)
    }
    return stored
  }

  async function authBindingOf(entry: CatalogEntry): Promise<AuthBinding> {
    if (!entry.auth.required) {
      return {
        providerKey: entry.auth.providerKey,
        status: "not_required",
      }
    }

    // For Google OAuth managed apps, check shared gauth.json directly
    const GOOGLE_OAUTH_APP_IDS = ["google-calendar", "gmail"]
    if (GOOGLE_OAUTH_APP_IDS.includes(entry.id)) {
      try {
        const gauthPath = path.join(Global.Path.config, "gauth.json")
        const file = Bun.file(gauthPath)
        if (await file.exists()) {
          const tokens = (await file.json()) as { access_token?: string }
          if (tokens && tokens.access_token) {
            return {
              providerKey: entry.auth.providerKey,
              accountId: `gauth-${entry.id}`,
              status: "authenticated",
            }
          }
        }
      } catch {
        // fall through to required
      }
      return {
        providerKey: entry.auth.providerKey,
        status: "required",
      }
    }

    // Fallback for other managed apps — use Account system
    const providerKey = await Account.resolveProviderOrSelf(entry.auth.providerKey)
    const providerAccounts = await Account.list(providerKey)
    const accountIds = Object.keys(providerAccounts)
    if (accountIds.length !== 1) {
      return {
        providerKey: entry.auth.providerKey,
        status: "required",
      }
    }

    const [accountId] = accountIds
    const auth = await Auth.get(accountId)
    if (!auth || !accountId) {
      return {
        providerKey: entry.auth.providerKey,
        status: "required",
      }
    }

    if (auth.type !== entry.auth.type) {
      return {
        providerKey: entry.auth.providerKey,
        accountId,
        status: "invalid",
      }
    }

    return {
      providerKey: entry.auth.providerKey,
      accountId,
      status: "authenticated",
    }
  }

  function runtimeStatusOf(state: AppState, authBinding: AuthBinding): RuntimeStatus {
    if (state.installState !== "installed") return "pending_install"
    if (state.error) return "error"
    if (authBinding.status === "required" || authBinding.status === "invalid") return "pending_auth"
    if (state.configStatus !== "configured") return "pending_config"
    if (state.enableState !== "enabled") return "disabled"
    return "ready"
  }

  function operatorStateOf(entry: CatalogEntry, state: AppState, authBinding: AuthBinding): OperatorState {
    return {
      install: state.installState === "installed" ? "installed" : "available",
      auth:
        authBinding.status === "not_required"
          ? "not_required"
          : authBinding.status === "required"
            ? "required"
            : authBinding.status === "invalid"
              ? "invalid"
              : "authenticated",
      config:
        entry.requiredConfig.length === 0
          ? "not_required"
          : state.configStatus === "required"
            ? "required"
            : state.configStatus === "invalid"
              ? "invalid"
              : "configured",
      runtime: state.error ? "error" : runtimeStatusOf(state, authBinding) === "ready" ? "ready" : "inactive",
      error: state.error
        ? state.configStatus === "invalid"
          ? "invalid_config"
          : "runtime_error"
        : authBinding.status === "required"
          ? "auth_required"
          : authBinding.status === "invalid"
            ? "invalid_auth"
            : "none",
    }
  }

  function requireCatalogEntry(appId: string): CatalogEntry {
    const entry = BUILTIN_CATALOG[appId]
    if (!entry) throw new AppNotFoundError({ message: `Unknown managed app: ${appId}` })
    return entry
  }

  function usageErrorOf(snapshot: ManagedAppSnapshot): UsageError | undefined {
    if (snapshot.runtime.status === "pending_auth") {
      return {
        appId: snapshot.catalog.id,
        status: snapshot.runtime.status,
        reason: "unauthenticated",
        code: snapshot.authBinding.status === "invalid" ? "MANAGED_APP_INVALID_AUTH" : "MANAGED_APP_AUTH_REQUIRED",
        message:
          snapshot.authBinding.status === "invalid"
            ? `Managed app ${snapshot.catalog.id} has invalid authentication binding`
            : `Managed app ${snapshot.catalog.id} requires exactly one authenticated account binding`,
      }
    }
    if (snapshot.runtime.status === "pending_config") {
      return {
        appId: snapshot.catalog.id,
        status: snapshot.runtime.status,
        reason: "misconfigured",
        code: "MANAGED_APP_CONFIG_REQUIRED",
        message: `Managed app ${snapshot.catalog.id} is misconfigured and cannot be used`,
      }
    }
    if (snapshot.runtime.status === "error") {
      return {
        appId: snapshot.catalog.id,
        status: snapshot.runtime.status,
        reason: "runtime_error",
        code: snapshot.persisted.error?.code ?? "MANAGED_APP_RUNTIME_ERROR",
        message: snapshot.persisted.error?.message ?? `Managed app ${snapshot.catalog.id} hit a runtime error`,
      }
    }
    return undefined
  }

  async function load(): Promise<Storage> {
    const file = Bun.file(filepath)
    if (!(await file.exists())) return { version: VERSION, apps: {} }
    try {
      const parsed = Storage.safeParse(await file.json())
      if (!parsed.success) throw new Error(parsed.error.message)
      return parsed.data
    } catch (error) {
      log.error("failed to load managed apps state", { error })
      throw error
    }
  }

  async function state(): Promise<Storage> {
    if (cache) {
      const nextMtime = await getDiskMtime()
      if (nextMtime === mtime) return cache
    }
    cache = await load()
    mtime = await getDiskMtime()
    return cache
  }

  async function save(next: Storage): Promise<void> {
    await fs.mkdir(path.dirname(filepath), { recursive: true }).catch(() => {})
    await Bun.write(filepath, JSON.stringify(next, null, 2))
    await fs.chmod(filepath, 0o600).catch(() => {})
    cache = next
    mtime = await getDiskMtime()
  }

  async function toSnapshot(entry: CatalogEntry, stored?: AppState): Promise<AppSnapshot> {
    const state = stored ?? defaultState(entry)
    const authBinding = await authBindingOf(entry)
    return {
      ...entry,
      state,
      authBinding,
      runtimeStatus: runtimeStatusOf(state, authBinding),
      operator: operatorStateOf(entry, state, authBinding),
    }
  }

  async function runtimeSnapshotOf(entry: CatalogEntry, state: AppState): Promise<RuntimeSnapshot> {
    const authBinding = await authBindingOf(entry)
    return {
      appId: state.appId,
      status: runtimeStatusOf(state, authBinding),
      attachment: runtimeAttachments.get(state.appId),
    }
  }

  async function managedSnapshotOf(entry: CatalogEntry, stored?: AppState): Promise<ManagedAppSnapshot> {
    const persisted = stored ?? defaultState(entry)
    const authBinding = await authBindingOf(entry)
    return {
      catalog: entry,
      persisted,
      authBinding,
      runtime: await runtimeSnapshotOf(entry, persisted),
      operator: operatorStateOf(entry, persisted, authBinding),
    }
  }

  async function persistAndPublish(next: Storage, appId: string) {
    await save(next)
    await Bus.publish(Event.Updated, { app: await toSnapshot(requireCatalogEntry(appId), next.apps[appId]) }).catch(
      () => {},
    )
  }

  export function catalog(): CatalogEntry[] {
    return Object.values(BUILTIN_CATALOG)
  }

  export async function list(): Promise<AppSnapshot[]> {
    const current = await state()
    return Promise.all(catalog().map((entry) => toSnapshot(entry, current.apps[entry.id])))
  }

  export async function get(appId: string): Promise<AppSnapshot> {
    const entry = requireCatalogEntry(appId)
    const current = await state()
    return toSnapshot(entry, current.apps[appId])
  }

  export async function snapshot(appId: string): Promise<ManagedAppSnapshot> {
    const entry = requireCatalogEntry(appId)
    const current = await state()
    return managedSnapshotOf(entry, current.apps[appId])
  }

  export async function runtime(appId: string): Promise<RuntimeSnapshot> {
    return (await snapshot(appId)).runtime
  }

  export async function requireReady(appId: string): Promise<ManagedAppSnapshot> {
    const current = await snapshot(appId)
    const usageError = usageErrorOf(current)
    if (usageError) throw new UsageStateError(usageError)
    if (current.runtime.status !== "ready")
      throw new UsageStateError({
        appId,
        status: current.runtime.status,
        reason: current.runtime.status === "pending_config" ? "misconfigured" : "runtime_error",
        code: "MANAGED_APP_NOT_READY",
        message: `Managed app is not ready: ${appId} (${current.runtime.status})`,
      })
    return current
  }

  export async function usage(appId: string): Promise<UsageError | null> {
    return usageErrorOf(await snapshot(appId)) ?? null
  }

  export async function publishUpdate(appId: string): Promise<void> {
    await Bus.publish(Event.Updated, { app: await get(appId) }).catch(() => {})
  }

  export async function activeGoogleAppIds(): Promise<string[]> {
    const current = await state()
    return GOOGLE_MANAGED_APP_IDS.filter((appId) => {
      const app = current.apps[appId]
      return app?.installState === "installed" && app.enableState === "enabled"
    })
  }

  export async function readyTools(): Promise<ReadyToolBinding[]> {
    const apps = await list()
    return apps.flatMap((app: AppSnapshot) => {
      if (app.runtimeStatus !== "ready") return []
      return app.toolContract.tools.map((tool: ToolDescriptor) => ({
        appId: app.id,
        namespace: app.toolContract.namespace,
        tool,
      }))
    })
  }

  export async function install(appId: string): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const now = Date.now()
      const existing = current.apps[appId] ?? defaultState(entry, now)
      if (existing.installState === "installed") return toSnapshot(entry, existing)
      const nextState: AppState = {
        ...existing,
        source: entry.source,
        installState: "installed",
        enableState: "disabled",
        error: undefined,
        installedAt: existing.installedAt ?? now,
        updatedAt: now,
      }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function uninstall(appId: string): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const reset = defaultState(entry, Date.now())
      runtimeAttachments.delete(appId)
      const next = { ...current, apps: { ...current.apps, [appId]: reset } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, reset)
    })
  }

  export async function setConfigStatus(
    appId: string,
    configStatus: ConfigStatus,
    error?: Omit<ErrorStatus, "ts">,
  ): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = current.apps[appId] ?? defaultState(entry)
      if (existing.installState !== "installed") {
        throw new Error(`Cannot update config for non-installed app: ${appId}`)
      }
      const nextState: AppState = {
        ...existing,
        configStatus,
        error: error ? { ...error, ts: Date.now() } : existing.error,
        updatedAt: Date.now(),
      }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function setConfigKeys(appId: string, keys: string[]): Promise<ManagedAppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = requireInstalledState(appId, entry, current)
      const now = Date.now()
      const nextState: AppState = {
        ...existing,
        config: { keys: Array.from(new Set(keys)).sort(), updatedAt: now },
        configStatus:
          entry.requiredConfig.length === 0 || entry.requiredConfig.every((k: string) => keys.includes(k))
            ? "configured"
            : "required",
        error: undefined,
        updatedAt: now,
      }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return managedSnapshotOf(entry, nextState)
    })
  }

  export async function enable(appId: string): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = current.apps[appId] ?? defaultState(entry)
      const authBinding = await authBindingOf(entry)
      if (existing.installState !== "installed") throw new Error(`Cannot enable app before install: ${appId}`)
      if (authBinding.status === "required" || authBinding.status === "invalid") {
        throw new UsageStateError({
          appId,
          status: "pending_auth",
          reason: "unauthenticated",
          code: authBinding.status === "invalid" ? "MANAGED_APP_INVALID_AUTH" : "MANAGED_APP_AUTH_REQUIRED",
          message:
            authBinding.status === "invalid"
              ? `Managed app ${appId} has invalid authentication binding`
              : `Managed app ${appId} requires exactly one authenticated account binding`,
        })
      }
      if (existing.configStatus !== "configured") {
        throw new Error(`Cannot enable app with config status ${existing.configStatus}: ${appId}`)
      }
      if (existing.error) throw new Error(`Cannot enable app in error state: ${appId}`)
      const nextState: AppState = { ...existing, enableState: "enabled", updatedAt: Date.now() }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function disable(appId: string): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = current.apps[appId] ?? defaultState(entry)
      if (existing.installState !== "installed") throw new Error(`Cannot disable non-installed app: ${appId}`)
      runtimeAttachments.delete(appId)
      const nextState: AppState = { ...existing, enableState: "disabled", updatedAt: Date.now() }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function markError(appId: string, error: Omit<ErrorStatus, "ts">): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = current.apps[appId] ?? defaultState(entry)
      if (existing.installState !== "installed") {
        throw new Error(`Cannot attach runtime error to non-installed app: ${appId}`)
      }
      const nextState: AppState = {
        ...existing,
        error: { ...error, ts: Date.now() },
        enableState: "disabled",
        updatedAt: Date.now(),
      }
      runtimeAttachments.delete(appId)
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function clearError(appId: string): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = current.apps[appId] ?? defaultState(entry)
      if (existing.installState !== "installed") {
        throw new Error(`Cannot clear runtime error for non-installed app: ${appId}`)
      }
      const nextState: AppState = { ...existing, error: undefined, updatedAt: Date.now() }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function attachRuntime(
    appId: string,
    attachment: Omit<RuntimeAttachment, "attachedAt">,
  ): Promise<ManagedAppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = requireInstalledState(appId, entry, current)
      const authBinding = await authBindingOf(entry)
      if (runtimeStatusOf(existing, authBinding) !== "ready") {
        throw new Error(`Cannot attach runtime for non-ready app: ${appId}`)
      }
      runtimeAttachments.set(appId, { ...attachment, attachedAt: Date.now() })
      return managedSnapshotOf(entry, existing)
    })
  }

  export async function detachRuntime(
    appId: string,
    owner?: Pick<RuntimeAttachment, "owner" | "ownerId">,
  ): Promise<ManagedAppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = requireInstalledState(appId, entry, current)
      const attached = runtimeAttachments.get(appId)
      if (owner && attached && (attached.owner !== owner.owner || attached.ownerId !== owner.ownerId)) {
        throw new Error(`Managed app runtime owned by another attachment: ${appId}`)
      }
      runtimeAttachments.delete(appId)
      return managedSnapshotOf(entry, existing)
    })
  }
}
