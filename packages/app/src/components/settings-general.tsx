import { Component, Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSync } from "@/context/sync"
import { useSettings, monoFontFamily } from "@/context/settings"
import { buildTriggerPayload, normalizeKillSwitchStatus } from "./settings-kill-switch"
import { formatRestartErrorResponse } from "@/utils/restart-errors"
import { playSound, SOUND_OPTIONS } from "@/utils/sound"
import { Link } from "./link"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const stopDemoSound = () => {
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}

const playDemoSound = (src: string | undefined) => {
  stopDemoSound()
  if (!src) return

  demoSoundState.timeout = setTimeout(() => {
    demoSoundState.cleanup = playSound(src)
  }, 100)
}

export const SettingsGeneral: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const platform = usePlatform()
  const globalSDK = useGlobalSDK()
  const settings = useSettings()
  const [restartState, setRestartState] = createSignal<"idle" | "restarting" | "waiting" | "error">("idle")
  const [restartMessage, setRestartMessage] = createSignal<string>("")
  const sync = useSync()
  const [killSwitchReason, setKillSwitchReason] = createSignal("")
  const [killSwitchMfa, setKillSwitchMfa] = createSignal("")
  const [killSwitchRequestID, setKillSwitchRequestID] = createSignal<string | null>(null)
  const [killSwitchMessage, setKillSwitchMessage] = createSignal("")
  const [killSwitchBusy, setKillSwitchBusy] = createSignal(false)
  const [killSwitchConfirm, setKillSwitchConfirm] = createSignal<"idle" | "trigger" | "cancel">("idle")
  const [killSwitchSnapshot, setKillSwitchSnapshot] = createSignal(true)

  const ksStatus = createMemo(() => {
    const sse = sync.data.killswitch_status
    if (sse) return { active: sse.active, state: sse.state, requestID: sse.requestID, snapshotURL: sse.snapshotURL }
    const fetched = killSwitchStatus()
    if (fetched) return { active: fetched.active, state: fetched.state, requestID: fetched.requestID, snapshotURL: fetched.snapshotURL }
    return undefined
  })

  const [killSwitchStatus, killSwitchActions] = createResource(async () => {
    const response = await globalSDK.fetch(`${globalSDK.url}/api/v2/admin/kill-switch/status`, {
      method: "GET",
      cache: "no-store",
    })
    if (!response.ok) throw new Error(`Status failed (${response.status})`)
    const data = await response.json()
    return normalizeKillSwitchStatus(data)
  })

  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const web = createMemo(() => platform.platform === "web")

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  const waitForRestartRecovery = async (input: { initialDelayMs: number; fallbackReloadAfterMs: number }) => {
    const healthUrl = `${globalSDK.url}/api/v2/global/health`
    const deadline = Date.now() + 30_000
    const fallbackAt = Date.now() + input.fallbackReloadAfterMs

    await wait(input.initialDelayMs)

    while (Date.now() < deadline) {
      try {
        const response = await fetch(healthUrl, { cache: "no-store" })
        if (response.ok) {
          const data = (await response.json()) as { healthy?: boolean }
          if (data.healthy) {
            if (
              Date.now() >= fallbackAt ||
              response.redirected ||
              response.url !== healthUrl ||
              document.visibilityState
            ) {
              window.location.reload()
              return
            }
            window.location.reload()
            return
          }
        }
      } catch {}
      await wait(1000)
    }

    setRestartState("error")
    setRestartMessage("Web restart was triggered, but automatic reload timed out. Please refresh manually.")
  }

  const restartWeb = async () => {
    if (restartState() === "restarting" || restartState() === "waiting") return
    if (!window.confirm("Restart the web runtime now? The page will reload automatically after recovery.")) return

    setRestartState("restarting")
    setRestartMessage("Requesting controlled web restart…")
    try {
      const response = await globalSDK.fetch(`${globalSDK.url}/api/v2/global/web/restart`, {
        method: "POST",
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(formatRestartErrorResponse(text, response.status))
      }
      const data = (await response.json()) as {
        recommendedInitialDelayMs: number
        fallbackReloadAfterMs: number
      }
      setRestartState("waiting")
      setRestartMessage("Restarting web runtime… this page will reload automatically.")
      await waitForRestartRecovery({
        initialDelayMs: data.recommendedInitialDelayMs,
        fallbackReloadAfterMs: data.fallbackReloadAfterMs,
      })
    } catch (error) {
      setRestartState("error")
      setRestartMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const readError = async (response: Response) => {
    try {
      const data = await response.json()
      if (typeof data?.reason === "string" && data.reason) return data.reason
      if (typeof data?.error === "string" && data.error) return data.error
      if (typeof data?.message === "string" && data.message) return data.message
      return `Request failed (${response.status})`
    } catch {
      return `Request failed (${response.status})`
    }
  }

  const triggerKillSwitch = async () => {
    if (killSwitchBusy()) return
    const reason = killSwitchReason().trim()
    if (!reason) {
      setKillSwitchMessage("Reason is required.")
      return
    }
    if (killSwitchConfirm() !== "trigger") {
      setKillSwitchConfirm("trigger")
      setKillSwitchMessage("Click Trigger again to confirm.")
      return
    }
    setKillSwitchConfirm("idle")

    setKillSwitchBusy(true)
    setKillSwitchMessage("")
    try {
      const first = await globalSDK.fetch(`${globalSDK.url}/api/v2/admin/kill-switch/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildTriggerPayload({ reason, snapshot: killSwitchSnapshot() })),
      })

      if (first.status === 202) {
        const challenge = (await first.json()) as { mfa_required?: boolean; request_id?: string }
        if (challenge?.mfa_required && challenge.request_id) {
          setKillSwitchRequestID(challenge.request_id)
          if (!killSwitchMfa().trim()) {
            setKillSwitchMessage(`MFA required. Enter code for request_id ${challenge.request_id}.`)
            return
          }
          const second = await globalSDK.fetch(`${globalSDK.url}/api/v2/admin/kill-switch/trigger`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              buildTriggerPayload({
                reason,
                requestID: challenge.request_id,
                mfaCode: killSwitchMfa().trim(),
              }),
            ),
          })
          if (!second.ok) {
            setKillSwitchMessage(await readError(second))
            return
          }
          const done = (await second.json()) as { request_id?: string; snapshot_url?: string | null }
          setKillSwitchRequestID(done.request_id ?? challenge.request_id)
          setKillSwitchMessage(
            `Triggered. request_id=${done.request_id ?? challenge.request_id}${done.snapshot_url ? ` snapshot=${done.snapshot_url}` : ""}`,
          )
          setKillSwitchMfa("")
          await killSwitchActions.refetch()
          return
        }
        setKillSwitchMessage("MFA required but challenge payload is invalid.")
        return
      }

      if (!first.ok) {
        setKillSwitchMessage(await readError(first))
        return
      }

      const done = (await first.json()) as { request_id?: string; snapshot_url?: string | null }
      setKillSwitchRequestID(done.request_id ?? null)
      setKillSwitchMessage(
        `Triggered. request_id=${done.request_id ?? "n/a"}${done.snapshot_url ? ` snapshot=${done.snapshot_url}` : ""}`,
      )
      await killSwitchActions.refetch()
    } catch (error) {
      setKillSwitchMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setKillSwitchBusy(false)
    }
  }

  const cancelKillSwitch = async () => {
    if (killSwitchBusy()) return
    if (killSwitchConfirm() !== "cancel") {
      setKillSwitchConfirm("cancel")
      setKillSwitchMessage("Click Cancel again to confirm.")
      return
    }
    setKillSwitchConfirm("idle")

    setKillSwitchBusy(true)
    setKillSwitchMessage("")
    try {
      const response = await globalSDK.fetch(`${globalSDK.url}/api/v2/admin/kill-switch/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestID: killSwitchRequestID() ?? undefined }),
      })
      if (!response.ok) {
        setKillSwitchMessage(await readError(response))
        return
      }
      const done = (await response.json()) as { request_id?: string | null }
      setKillSwitchMessage(`Canceled.${done.request_id ? ` request_id=${done.request_id}` : ""}`)
      await killSwitchActions.refetch()
    } catch (error) {
      setKillSwitchMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setKillSwitchBusy(false)
    }
  }

  const themeOptions = createMemo(() =>
    Object.entries(theme.themes()).map(([id, def]) => ({ id, name: def.name ?? id })),
  )

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  const fontOptions = [
    { value: "ibm-plex-mono", label: "font.option.ibmPlexMono" },
    { value: "cascadia-code", label: "font.option.cascadiaCode" },
    { value: "fira-code", label: "font.option.firaCode" },
    { value: "hack", label: "font.option.hack" },
    { value: "inconsolata", label: "font.option.inconsolata" },
    { value: "intel-one-mono", label: "font.option.intelOneMono" },
    { value: "iosevka", label: "font.option.iosevka" },
    { value: "jetbrains-mono", label: "font.option.jetbrainsMono" },
    { value: "meslo-lgs", label: "font.option.mesloLgs" },
    { value: "roboto-mono", label: "font.option.robotoMono" },
    { value: "source-code-pro", label: "font.option.sourceCodePro" },
    { value: "ubuntu-mono", label: "font.option.ubuntuMono" },
  ] as const
  const fontOptionsList = [...fontOptions]

  const noneSound = { id: "none", label: "sound.option.none", src: undefined } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]

  const soundSelectProps = (
    enabled: () => boolean,
    current: () => string,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    options: soundOptions,
    current: enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound,
    value: (o: (typeof soundOptions)[number]) => o.id,
    label: (o: (typeof soundOptions)[number]) => language.t(o.label),
    onHighlight: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      playDemoSound(option.src)
    },
    onSelect: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        stopDemoSound()
        return
      }
      setEnabled(true)
      set(option.id)
      playDemoSound(option.src)
    },
    variant: "secondary" as const,
    size: "small" as const,
    triggerVariant: "settings" as const,
  })

  const AppearanceSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.appearance")}</h3>

      <div class="bg-surface-raised-base px-4 rounded-lg">
        <SettingsRow
          title={language.t("settings.general.row.language.title")}
          description={language.t("settings.general.row.language.description")}
        >
          <Select
            data-action="settings-language"
            options={languageOptions()}
            current={languageOptions().find((o) => o.value === language.locale())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && language.setLocale(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.appearance.title")}
          description={language.t("settings.general.row.appearance.description")}
        >
          <Select
            data-action="settings-color-scheme"
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && theme.setColorScheme(option.value)}
            onHighlight={(option) => {
              if (!option) return
              theme.previewColorScheme(option.value)
              return () => theme.cancelPreview()
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.theme.title")}
          description={
            <>
              {language.t("settings.general.row.theme.description")}{" "}
              <Link href="https://opencode.ai/docs/themes/">{language.t("common.learnMore")}</Link>
            </>
          }
        >
          <Select
            data-action="settings-theme"
            options={themeOptions()}
            current={themeOptions().find((o) => o.id === theme.themeId())}
            value={(o) => o.id}
            label={(o) => o.name}
            onSelect={(option) => {
              if (!option) return
              theme.setTheme(option.id)
            }}
            onHighlight={(option) => {
              if (!option) return
              theme.previewTheme(option.id)
              return () => theme.cancelPreview()
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.font.title")}
          description={language.t("settings.general.row.font.description")}
        >
          <Select
            data-action="settings-font"
            options={fontOptionsList}
            current={fontOptionsList.find((o) => o.value === settings.appearance.font())}
            value={(o) => o.value}
            label={(o) => language.t(o.label)}
            onSelect={(option) => option && settings.appearance.setFont(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "font-family": monoFontFamily(settings.appearance.font()), "min-width": "180px" }}
          >
            {(option) => (
              <span style={{ "font-family": monoFontFamily(option?.value) }}>
                {option ? language.t(option.label) : ""}
              </span>
            )}
          </Select>
        </SettingsRow>
      </div>
    </div>
  )

  const NotificationsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.notifications")}</h3>

      <div class="bg-surface-raised-base px-4 rounded-lg">
        <SettingsRow
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRow>
      </div>
    </div>
  )

  const FeedSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.feed")}</h3>

      <div class="bg-surface-raised-base px-4 rounded-lg">
        <SettingsRow
          title={language.t("settings.general.row.shellToolPartsExpanded.title")}
          description={language.t("settings.general.row.shellToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-shell-tool-parts-expanded">
            <Switch
              checked={settings.general.shellToolPartsExpanded()}
              onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.editToolPartsExpanded.title")}
          description={language.t("settings.general.row.editToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-edit-tool-parts-expanded">
            <Switch
              checked={settings.general.editToolPartsExpanded()}
              onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.reasoningSummaries.title")}
          description={language.t("settings.general.row.reasoningSummaries.description")}
        >
          <div data-action="settings-feed-reasoning-summaries">
            <Switch
              checked={settings.general.showReasoningSummaries()}
              onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
            />
          </div>
        </SettingsRow>
      </div>
    </div>
  )

  const SoundsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.sounds")}</h3>

      <div class="bg-surface-raised-base px-4 rounded-lg">
        <SettingsRow
          title={language.t("settings.general.sounds.agent.title")}
          description={language.t("settings.general.sounds.agent.description")}
        >
          <Select
            data-action="settings-sounds-agent"
            {...soundSelectProps(
              () => settings.sounds.agentEnabled(),
              () => settings.sounds.agent(),
              (value) => settings.sounds.setAgentEnabled(value),
              (id) => settings.sounds.setAgent(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.permissions.title")}
          description={language.t("settings.general.sounds.permissions.description")}
        >
          <Select
            data-action="settings-sounds-permissions"
            {...soundSelectProps(
              () => settings.sounds.permissionsEnabled(),
              () => settings.sounds.permissions(),
              (value) => settings.sounds.setPermissionsEnabled(value),
              (id) => settings.sounds.setPermissions(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.errors.title")}
          description={language.t("settings.general.sounds.errors.description")}
        >
          <Select
            data-action="settings-sounds-errors"
            {...soundSelectProps(
              () => settings.sounds.errorsEnabled(),
              () => settings.sounds.errors(),
              (value) => settings.sounds.setErrorsEnabled(value),
              (id) => settings.sounds.setErrors(id),
            )}
          />
        </SettingsRow>
      </div>
    </div>
  )

  const RuntimeSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">Runtime</h3>

      <div class="bg-surface-raised-base px-4 rounded-lg">
        <SettingsRow
          title="Restart Web"
          description="Schedule a controlled web runtime restart. In webctl/dev mode this may rebuild frontend before restarting; if it fails, the UI will show a restart TX and error-log path. This page will reload automatically after the server becomes healthy again."
        >
          <div class="flex flex-col items-end gap-2">
            <Button
              size="small"
              variant="secondary"
              onClick={() => void restartWeb()}
              disabled={restartState() === "restarting" || restartState() === "waiting"}
            >
              {restartState() === "restarting" || restartState() === "waiting" ? "Restarting…" : "Restart Web"}
            </Button>
            <Show when={restartMessage()}>
              {(message) => (
                <span
                  class="max-w-72 text-right text-11-regular"
                  classList={{
                    "text-text-weak": restartState() !== "error",
                    "text-text-danger": restartState() === "error",
                  }}
                >
                  {message()}
                </span>
              )}
            </Show>
          </div>
        </SettingsRow>

        <SettingsRow
          title="Kill-Switch"
          description="Emergency control for global pause/resume. Trigger supports MFA challenge flow."
        >
          <div class="flex flex-col items-end gap-2 w-[420px] max-w-full">
            <div class="flex items-center gap-2 text-12-medium">
              <span
                classList={{
                  "px-2 py-0.5 rounded-full text-11-medium": true,
                  "bg-red-500/15 text-red-500": !!ksStatus()?.active,
                  "bg-emerald-500/15 text-emerald-500": !ksStatus()?.active,
                }}
              >
                {killSwitchStatus.loading ? "loading…" : ksStatus()?.active ? "ACTIVE" : "inactive"}
              </span>
              <Show when={ksStatus()?.active}>
                <span class="text-11-regular text-text-weak">
                  {ksStatus()?.state} · {ksStatus()?.requestID ?? "-"}
                </span>
              </Show>
            </div>
            <Show when={ksStatus()?.snapshotURL}>
              <span class="text-11-regular text-text-weak text-right break-all">
                snapshot: {ksStatus()!.snapshotURL}
              </span>
            </Show>

            <div class="w-full">
              <TextField
                value={killSwitchReason()}
                onChange={(v) => { setKillSwitchReason(v); setKillSwitchConfirm("idle") }}
                placeholder="Reason (required)"
                hideLabel
                disabled={killSwitchBusy()}
              />
            </div>

            <Show when={killSwitchRequestID()}>
              <div class="w-full">
                <TextField
                  value={killSwitchMfa()}
                  onChange={setKillSwitchMfa}
                  placeholder="MFA code"
                  hideLabel
                  disabled={killSwitchBusy()}
                />
              </div>
            </Show>

            <div class="flex items-center gap-2">
              <label class="flex items-center gap-1.5 text-11-regular text-text-weak cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={killSwitchSnapshot()}
                  onChange={(e) => setKillSwitchSnapshot(e.currentTarget.checked)}
                  disabled={killSwitchBusy()}
                  class="accent-current"
                />
                Snapshot
              </label>
              <div class="flex-1" />
              <Button
                size="small"
                variant="secondary"
                onClick={() => void cancelKillSwitch()}
                disabled={killSwitchBusy()}
              >
                {killSwitchConfirm() === "cancel" ? "Confirm Cancel" : "Cancel"}
              </Button>
              <Button
                size="small"
                variant="primary"
                onClick={() => void triggerKillSwitch()}
                disabled={killSwitchBusy()}
              >
                {killSwitchConfirm() === "trigger" ? "Confirm Trigger" : "Trigger"}
              </Button>
            </div>

            <Show when={killSwitchMessage()}>
              {(message) => (
                <span class="max-w-full text-right text-11-regular text-text-danger-base break-words">{message()}</span>
              )}
            </Show>
          </div>
        </SettingsRow>
      </div>
    </div>
  )

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.general")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <AppearanceSection />

        <FeedSection />

        <NotificationsSection />

        <SoundsSection />

        <Show when={web()}>
          <RuntimeSection />
        </Show>

        <Show when={platform.platform === "desktop" && platform.os === "windows" && platform.getWslEnabled}>
          {(_) => {
            const [enabledResource, actions] = createResource(() => platform.getWslEnabled?.())
            const enabled = () => (enabledResource.state === "pending" ? undefined : enabledResource.latest)

            return (
              <div class="flex flex-col gap-1">
                <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.desktop.section.wsl")}</h3>

                <div class="bg-surface-raised-base px-4 rounded-lg">
                  <SettingsRow
                    title={language.t("settings.desktop.wsl.title")}
                    description={language.t("settings.desktop.wsl.description")}
                  >
                    <div data-action="settings-wsl">
                      <Switch
                        checked={enabled() ?? false}
                        disabled={enabledResource.state === "pending"}
                        onChange={(checked) => platform.setWslEnabled?.(checked)?.finally(() => actions.refetch())}
                      />
                    </div>
                  </SettingsRow>
                </div>
              </div>
            )
          }}
        </Show>

        <Show when={linux()}>
          {(_) => {
            const [valueResource, actions] = createResource(() => platform.getDisplayBackend?.())
            const value = () => (valueResource.state === "pending" ? undefined : valueResource.latest)

            const onChange = (checked: boolean) =>
              platform.setDisplayBackend?.(checked ? "wayland" : "auto").finally(() => actions.refetch())

            return (
              <div class="flex flex-col gap-1">
                <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.display")}</h3>

                <div class="bg-surface-raised-base px-4 rounded-lg">
                  <SettingsRow
                    title={
                      <div class="flex items-center gap-2">
                        <span>{language.t("settings.general.row.wayland.title")}</span>
                        <Tooltip value={language.t("settings.general.row.wayland.tooltip")} placement="top">
                          <span class="text-text-weak">
                            <Icon name="help" size="small" />
                          </span>
                        </Tooltip>
                      </div>
                    }
                    description={language.t("settings.general.row.wayland.description")}
                  >
                    <div data-action="settings-wayland">
                      <Switch checked={value() === "wayland"} onChange={onChange} />
                    </div>
                  </SettingsRow>
                </div>
              </div>
            )
          }}
        </Show>
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.children}</div>
    </div>
  )
}
