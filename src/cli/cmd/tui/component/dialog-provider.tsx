import { onMount, createSignal, createMemo, Switch, Match, Show, type JSX } from "solid-js"
import { Log } from "@/util/log"
import { useSync } from "@tui/context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization } from "@opencode-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useKeyboard } from "@opentui/solid"
import { Clipboard } from "@tui/util/clipboard"
import { useToast } from "../ui/toast"
import open from "open"

const PROVIDER_PRIORITY: Record<string, number> = {
  opencode: 0,
  anthropic: 1,
  "github-copilot": 2,
  openai: 3,
  "google-api": 4,
}

async function startProviderAuth(
  providerId: string,
  dialog: ReturnType<typeof useDialog>,
  sync: ReturnType<typeof useSync>,
  sdk: ReturnType<typeof useSDK>,
) {
  const rawMethods = sync.data.provider_auth[providerId] ?? [
    {
      type: "api",
      label: "API key",
    },
  ]
  const methods = providerId === "google-api" ? rawMethods.filter((x) => x.type === "api") : rawMethods
  const availableMethods = methods.length > 0 ? methods : rawMethods
  let index: number | null = 0
  if (availableMethods.length > 1) {
    index = await new Promise<number | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title="Select auth method"
            options={availableMethods.map((x, index) => ({
              title: x.label,
              value: index,
            }))}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(null),
      )
    })
  }
  if (index == null) return
  const method = availableMethods[index]
  if (method.type === "oauth") {
    const result = await sdk.client.provider.oauth.authorize({
      providerId,
      method: index,
    })
    if (result.data?.method === "code") {
      dialog.replace(() => (
        <CodeMethod providerId={providerId} title={method.label} index={index} authorization={result.data!} />
      ))
    }
    if (result.data?.method === "auto") {
      dialog.replace(() => (
        <AutoMethod providerId={providerId} title={method.label} index={index} authorization={result.data!} />
      ))
    }
  }
  if (method.type === "api") {
    return dialog.replace(() => <ApiMethod providerId={providerId} title={method.label} />)
  }
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const connected = createMemo(() => new Set(sync.data.provider_next.connected))
  const options = createMemo(() => {
    return pipe(
      sync.data.provider_next.all,
      sortBy((x) => PROVIDER_PRIORITY[x.id] ?? 99),
      map((provider) => {
        const isConnected = connected().has(provider.id)
        return {
          title: provider.name,
          value: provider.id,
          description: {
            opencode: "(Recommended)",
            anthropic: "(Claude Max or API key)",
            openai: "(ChatGPT Plus/Pro or API key)",
          }[provider.id],
          category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Other",
          footer: isConnected ? "Connected" : undefined,
          async onSelect() {
            await startProviderAuth(provider.id, dialog, sync, sdk)
          },
        }
      }),
    )
  })
  return options
}

export function DialogProvider(props: { providerId?: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()
  const options = createDialogProviderOptions()

  onMount(() => {
    if (props.providerId) {
      void startProviderAuth(props.providerId, dialog, sync, sdk)
    }
  })

  return (
    <Show
      when={props.providerId}
      fallback={
        <DialogSelect
          title="Connect a provider"
          options={options()}
          keybind={[
            {
              keybind: { name: "left", ctrl: false, meta: false, shift: false, super: false, leader: false },
              title: "Back",
              onTrigger: () => {
                dialog.clear()
              },
            },
          ]}
        />
      }
    >
      <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            Connect a provider
          </text>
          <text fg={theme.textMuted}>esc</text>
        </box>
        <text fg={theme.textMuted}>Opening authentication...</text>
      </box>
    </Show>
  )
}

interface AutoMethodProps {
  index: number
  providerId: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()
  const [hover, setHover] = createSignal(false)

  useKeyboard((evt) => {
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(toast.error)
    }
  })

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerId: props.providerId,
      method: props.index,
    })
    if (result.error) {
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerId={props.providerId} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={hover() ? theme.primary : undefined}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => dialog.clear()}
        >
          <text fg={hover() ? theme.selectedListItemText : theme.textMuted}>esc</text>
        </box>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerId: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)
  const toast = useToast()

  useKeyboard((evt) => {
    if (evt.name === "c" && evt.meta) {
      Clipboard.copy(props.authorization.url)
        .then(() => toast.show({ message: "URL copied to clipboard", variant: "info" }))
        .catch(toast.error)
    }
    if (evt.name === "o" && evt.meta) {
      open(props.authorization.url).catch(() => {})
    }
  })

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerId: props.providerId,
          method: props.index,
          code: value,
        })
        if (!error) {
          toast.show({ message: "Authentication successful!", variant: "success" })
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerId={props.providerId} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <box flexDirection="row" gap={2}>
            <text fg={theme.text}>
              alt+c <span style={{ fg: theme.textMuted }}>copy url</span>
            </text>
            <text fg={theme.text}>
              alt+o <span style={{ fg: theme.textMuted }}>open browser</span>
            </text>
          </box>
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerId: string
  title: string
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const needsName = () => props.providerId === "google-api"
  const [step, setStep] = createSignal<"name" | "api">(needsName() ? "name" : "api")
  const [name, setName] = createSignal("")

  const providerKey = () => {
    if (!needsName()) return props.providerId
    const trimmed = name().trim()
    if (!trimmed) return ""
    return `${props.providerId}-${trimmed}`
  }

  return (
    <Switch>
      <Match when={step() === "name"}>
        <DialogPrompt
          title="Account name"
          placeholder="e.g. yeatsluo"
          onConfirm={(value) => {
            const trimmed = value.trim()
            if (!trimmed) {
              Log.Default.warn("Empty account name submitted")
              return
            }
            Log.Default.info("Account name confirmed", { name: trimmed })
            setName(trimmed)
            setStep("api")
          }}
        />
      </Match>
      <Match when={step() === "api"}>
        <DialogPrompt
          title={props.title}
          placeholder="API key"
          description={
            // @event_2026-02-06_fix-connect: wrap JSX in function for dialog-prompt
            props.providerId === "opencode"
              ? () => (
                  <box gap={1}>
                    <text fg={theme.textMuted}>
                      OpenCode Zen gives you access to all the best coding models at the cheapest prices with a single
                      API key.
                    </text>
                    <text fg={theme.text}>
                      Go to <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> to get a key
                    </text>
                  </box>
                )
              : undefined
          }
          onConfirm={async (value) => {
            const trimmed = value.trim()
            if (!trimmed) return
            const pid = providerKey()
            if (!pid) return
            Log.Default.info("API key submitted", { providerId: pid })
            await sdk.client.auth.set({
              providerId: pid,
              auth: {
                type: "api",
                key: trimmed,
              },
            })
            await sdk.client.instance.dispose()
            await sync.bootstrap()
            dialog.replace(() => <DialogModel providerId={props.providerId} />)
          }}
          onCancel={() => {
            if (needsName()) setStep("name")
            else dialog.clear()
          }}
        />
      </Match>
    </Switch>
  )
}
