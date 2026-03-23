import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Clipboard } from "@tui/util/clipboard"
import { TextAttributes } from "@opentui/core"
import { RouteProvider, useRoute } from "@tui/context/route"
import {
  Switch,
  Match,
  createEffect,
  untrack,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
  on,
} from "solid-js"
import { Installation } from "@/installation"
import { Account } from "@/account"
import { Flag } from "@/flag/flag"
import { DialogProvider, useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderList } from "@tui/component/dialog-provider"
import { SDKProvider, useSDK } from "@tui/context/sdk"
import { SyncProvider, useSync } from "@tui/context/sync"
import { LocalProvider, useLocal } from "@tui/context/local"
import { DialogModel, useConnected } from "@tui/component/dialog-model"
import { DialogMcp } from "@tui/component/dialog-mcp"
import { DialogStatus } from "@tui/component/dialog-status"
import { DialogThemeList } from "@tui/component/dialog-theme-list"
import { DialogHelp } from "./ui/dialog-help"
import { CommandProvider, useCommandDialog } from "@tui/component/dialog-command"
import { DialogAgent } from "@tui/component/dialog-agent"
import { DialogSessionList } from "@tui/component/dialog-session-list"
import { DialogAccount } from "@tui/component/dialog-account"
import { DialogAdmin } from "@tui/component/dialog-admin"
import { DialogWorkspace } from "@tui/component/dialog-workspace"
import { KeybindProvider } from "@tui/context/keybind"
import { ThemeProvider, useTheme } from "@tui/context/theme"
import { Home } from "@tui/routes/home"
import { Session } from "@tui/routes/session"
import { PromptHistoryProvider, type PromptInfo } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogAlert } from "./ui/dialog-alert"
import { ToastProvider, useToast } from "./ui/toast"
import { ExitProvider, useExit } from "./context/exit"
import { Session as SessionApi } from "@/session"
import { TuiEvent } from "./event"
import { KVProvider, useKV } from "./context/kv"
import { Provider } from "@/provider/provider"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import open from "open"
import { writeHeapSnapshot } from "v8"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { debugCheckpoint } from "@/util/debug"
import { Env } from "@/env"
import { clone } from "remeda"
import { ActivityBeacon } from "@/util/activity-beacon"

async function getTerminalBackgroundColor(): Promise<"dark" | "light"> {
  // FIX: terminal raw-mode probing can hang/derail some emulators/bridges.
  // Default to dark unless explicitly enabled for diagnostics.
  // @event_20260210_tui_startup_rawmode_probe_guard
  if (process.env.OPENCODE_TUI_DETECT_BG !== "1") return "dark"
  // can't set raw mode if not a TTY
  if (!process.stdin.isTTY) return "dark"

  return new Promise((resolve) => {
    let resolved = false
    let timeout: NodeJS.Timeout

    const cleanup = () => {
      try {
        if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false)
      } catch (error) {
        debugCheckpoint("tui.startup", "failed to restore stdin raw mode", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      process.stdin.removeListener("data", handler)
      clearTimeout(timeout)
    }

    const done = (mode: "dark" | "light") => {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(mode)
    }

    const handler = (data: Buffer) => {
      const str = data.toString()
      const match = str.match(/\x1b]11;([^\x07\x1b]+)/)
      if (match) {
        const color = match[1]
        // Parse RGB values from color string
        // Formats: rgb:RR/GG/BB or #RRGGBB or rgb(R,G,B)
        let r = 0,
          g = 0,
          b = 0

        if (color.startsWith("rgb:")) {
          const parts = color.substring(4).split("/")
          r = parseInt(parts[0], 16) >> 8 // Convert 16-bit to 8-bit
          g = parseInt(parts[1], 16) >> 8 // Convert 16-bit to 8-bit
          b = parseInt(parts[2], 16) >> 8 // Convert 16-bit to 8-bit
        } else if (color.startsWith("#")) {
          r = parseInt(color.substring(1, 3), 16)
          g = parseInt(color.substring(3, 5), 16)
          b = parseInt(color.substring(5, 7), 16)
        } else if (color.startsWith("rgb(")) {
          const parts = color.substring(4, color.length - 1).split(",")
          r = parseInt(parts[0])
          g = parseInt(parts[1])
          b = parseInt(parts[2])
        }

        // Calculate luminance using relative luminance formula
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255

        // Determine if dark or light based on luminance threshold
        done(luminance > 0.5 ? "light" : "dark")
      }
    }

    try {
      process.stdin.setRawMode(true)
    } catch {
      done("dark")
      return
    }
    process.stdin.on("data", handler)
    process.stdout.write("\x1b]11;?\x07")

    timeout = setTimeout(() => {
      done("dark")
    }, 1000)
  })
}

import type { EventSource } from "./context/sdk"

export function tui(input: {
  url: string
  args: Args
  directory?: string
  fetch?: typeof fetch
  events?: EventSource
  onExit?: () => Promise<void>
}) {
  // promise to prevent immediate exit
  return new Promise<void>(async (resolve) => {
    debugCheckpoint("tui.startup", "begin")
    const mode = await getTerminalBackgroundColor()
    debugCheckpoint("tui.startup", "bg_mode_resolved", { mode })
    const onExit = async () => {
      await input.onExit?.()
      resolve()
    }

    debugCheckpoint("tui.startup", "render_init")

    const isVscodeTerminal =
      process.env.TERM_PROGRAM === "vscode" ||
      !!process.env.VSCODE_PID ||
      !!process.env.VSCODE_IPC_HOOK_CLI ||
      !!process.env.VSCODE_INJECTION

    // Performance: allow lowering TUI render FPS.
    // VS Code integrated terminal tends to be more CPU-sensitive, so we default lower there.
    const targetFps = (() => {
      const raw = process.env.OPENCODE_TUI_FPS
      if (!raw) return isVscodeTerminal ? 15 : 60
      const n = Number(raw)
      if (!Number.isFinite(n)) return isVscodeTerminal ? 15 : 60
      return Math.max(1, Math.min(60, Math.floor(n)))
    })()

    // Keep mouse clicks available by default for UI affordances (sidebar toggles, dialogs).
    // High-churn motion events remain separately gated by OPENCODE_TUI_MOUSE_MOVE.
    // Override with OPENCODE_TUI_MOUSE=1 or OPENCODE_TUI_MOUSE=0.
    const useMouse = (() => {
      const raw = process.env.OPENCODE_TUI_MOUSE
      if (raw === undefined) return true
      return raw !== "0"
    })()

    // Default: movement disabled (reduces background event churn).
    // Enable with OPENCODE_TUI_MOUSE_MOVE=1.
    const enableMouseMovement = process.env.OPENCODE_TUI_MOUSE_MOVE === "1"

    // Resize debounce: VS Code can emit frequent resize updates.
    const debounceDelay = (() => {
      const raw = process.env.OPENCODE_TUI_DEBOUNCE_MS
      if (!raw) return isVscodeTerminal ? 250 : 100
      const n = Number(raw)
      if (!Number.isFinite(n)) return isVscodeTerminal ? 250 : 100
      return Math.max(0, Math.min(2000, Math.floor(n)))
    })()

    debugCheckpoint("tui.startup", "render_options", {
      targetFps,
      debounceDelay,
      useMouse,
      enableMouseMovement,
      isVscodeTerminal,
    })

    render(
      () => {
        return (
          <ErrorBoundary
            fallback={(error, reset) => {
              const msg = error instanceof Error ? error.stack || error.message : String(error)
              debugCheckpoint("error", "boundary", { error: msg })
              return <ErrorComponent error={error} reset={reset} onExit={onExit} mode={mode} />
            }}
          >
            <ArgsProvider {...input.args}>
              <ExitProvider onExit={onExit}>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider>
                      <SDKProvider
                        url={input.url}
                        directory={input.directory}
                        fetch={input.fetch}
                        events={input.events}
                      >
                        <SyncProvider>
                          <ThemeProvider mode={mode}>
                            <LocalProvider>
                              <KeybindProvider>
                                <PromptStashProvider>
                                  <DialogProvider>
                                    <CommandProvider>
                                      <FrecencyProvider>
                                        <PromptHistoryProvider>
                                          <PromptRefProvider>
                                            <App />
                                          </PromptRefProvider>
                                        </PromptHistoryProvider>
                                      </FrecencyProvider>
                                    </CommandProvider>
                                  </DialogProvider>
                                </PromptStashProvider>
                              </KeybindProvider>
                            </LocalProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </SDKProvider>
                    </RouteProvider>
                  </ToastProvider>
                </KVProvider>
              </ExitProvider>
            </ArgsProvider>
          </ErrorBoundary>
        )
      },
      {
        debounceDelay,
        targetFps,
        // Some render paths use maxFps as the primary cap.
        // Keep them aligned so OPENCODE_TUI_FPS reliably throttles rendering.
        maxFps: targetFps,
        // Diagnostics / perf tuning
        useThread: process.env.OPENCODE_TUI_USE_THREAD === "1",
        gatherStats: process.env.OPENCODE_TUI_GATHER_STATS === "1",
        useMouse,
        enableMouseMovement,
        exitOnCtrlC: false,
        // Keep runtime errors in-app (ErrorBoundary) instead of opening the raw console overlay.
        // @event_20260226_origin_dev_refactor_round25_tui_open_console_error
        openConsoleOnError: false,
        // FIX: Some terminal emulators/bridges mishandle Kitty keyboard negotiation,
        // causing black-screen/unresponsive startup states.
        // Disable protocol negotiation for broader terminal compatibility.
        // @event_20260210_tui_black_screen_terminal_negotiation
        useKittyKeyboard: null,
        consoleOptions: {
          keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
          onCopySelection: (text) => {
            Clipboard.copy(text).catch((error) => {
              console.error(`Failed to copy console selection to clipboard: ${error}`)
            })
          },
        },
      },
    )
    debugCheckpoint("tui.startup", "render_started")
  })
}

function clonePromptInfo(prompt?: PromptInfo): PromptInfo | undefined {
  if (!prompt?.input) return undefined
  return {
    input: prompt.input,
    parts: clone(prompt.parts),
  }
}

function App() {
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  renderer.disableStdoutInterception()
  onMount(() => {
    // Prefer renderer "auto" mode so it can go idle when nothing changes.
    // This is important for low CPU usage when the TUI is not being interacted with.
    renderer.auto()
    // Activate the opentui console panel so Toggle Console has log content.
    // This overrides console.log/warn/error/debug to feed into TerminalConsoleCache.
    renderer.console.activate()
    debugCheckpoint("app", "mount")
  })
  onCleanup(() => {
    debugCheckpoint("app", "cleanup")
  })
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const defaultAnimationsEnabled = process.env.TERM_PROGRAM === "vscode" || process.env.VSCODE_PID ? false : true
  const command = useCommandDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme, mode, setMode } = useTheme()
  const sync = useSync()
  const beacon = ActivityBeacon.scope("tui.app")

  createEffect(() => {
    beacon.setGauge("route", route.data.type)
    beacon.setGauge("dialog_count", dialog.stack.length)
  })

  createEffect(() => {
    const trigger = kv.get("ui_trigger")
    if (!trigger) return

    // Clear trigger immediately
    kv.set("ui_trigger", null)

    switch (trigger) {
      case "session.list":
        dialog.replace(() => <DialogSessionList />)
        break
      case "session.list.refresh":
        sync.bootstrap().finally(() => {
          dialog.replace(() => <DialogSessionList />)
        })
        break
      case "model.list":
        dialog.replace(() => <DialogModel />)
        break
      case "provider.list":
        dialog.replace(() => <DialogProviderList />)
        break
      case "admin.panel":
        dialog.replace(() => <DialogAdmin />)
        break
      case "help.show":
        dialog.replace(() => <DialogHelp />)
        break
      case "session.new": {
        const current = promptRef.current
        const currentPrompt = clonePromptInfo(current?.current)
        route.navigate({
          type: "home",
          initialPrompt: currentPrompt,
        })
        dialog.clear()
        break
      }
    }
  })

  const exit = useExit()
  const promptRef = usePromptRef()

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await Clipboard.copy(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)
    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))

  createEffect(
    on(
      () => dialog.stack.length,
      (size) => {
        if (size !== 0) return
        promptRef.current?.focus()
      },
    ),
  )

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || Flag.OPENCODE_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle("OpenCode")
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || SessionApi.isDefaultTitle(session.title)) {
        renderer.setTerminalTitle("OpenCode")
        return
      }

      // Truncate title to 40 chars max
      const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
      renderer.setTerminalTitle(`OC | ${title}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerId, modelID } = Provider.parseModel(args.model)
        if (!providerId || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        const targetSessionID = args.sessionID ?? (route.data.type === "session" ? route.data.sessionID : undefined)
        const targetProviderKey = Account.parseProvider(providerId) ?? Account.parseFamily(providerId) ?? providerId
        void Account.getActive(targetProviderKey).then((accountId: string | undefined) => {
          local.model.set(
            { providerId, modelID, accountId: accountId ?? undefined },
            { recent: true, interrupt: true, syncSessionExecution: true },
            targetSessionID,
          )
        })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
      const autoAdmin = Env.get("OPENCODE_ADMIN_AUTO") === "1"
      if (args.admin || autoAdmin) {
        if (autoAdmin) debugCheckpoint("admin", "auto panel")
        dialog.replace(() => <DialogAdmin />)
      }
    })
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        sdk.client.session.fork({ sessionID: match }).then((result) => {
          if (result.data?.id) {
            route.navigate({ type: "session", sessionID: result.data.id })
          } else {
            toast.show({ message: "Failed to fork session", variant: "error" })
          }
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: "Failed to fork session", variant: "error" })
      }
    })
  })

  createEffect(
    on(
      () => sync.status === "complete" && sync.data.provider.length === 0,
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        if (!isEmpty || wasEmpty) return
        dialog.replace(() => <DialogProviderList />)
      },
    ),
  )

  const connected = useConnected()
  command.register(() => [
    {
      title: "Switch session",
      value: "session.list",
      keybind: "session_list",
      category: "Session",
      suggested: sync.data.session.length > 0,
      slash: { name: "session" },
      onSelect: () => {
        dialog.replace(() => <DialogSessionList />)
      },
    },
    {
      title: "New session",
      suggested: route.data.type === "session",
      value: "session.new",
      keybind: "session_new",
      category: "Session",
      slash: { name: "new" },
      onSelect: () => {
        const current = promptRef.current
        // Don't require focus - if there's any text, preserve it
        const currentPrompt = clonePromptInfo(current?.current)
        route.navigate({
          type: "home",
          initialPrompt: currentPrompt,
        })
        dialog.clear()
      },
    },
    {
      title: "Switch model",
      value: "model.list",
      keybind: "model_list",
      suggested: true,
      category: "Agent",
      slash: { name: "model" },
      onSelect: () => {
        dialog.replace(() => <DialogModel />)
      },
    },
    {
      title: "Model cycle",
      value: "model.cycle_recent",
      keybind: "model_cycle_recent",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.model.cycle(1, route.data.type === "session" ? route.data.sessionID : undefined)
      },
    },
    {
      title: "Model cycle reverse",
      value: "model.cycle_recent_reverse",
      keybind: "model_cycle_recent_reverse",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.model.cycle(-1, route.data.type === "session" ? route.data.sessionID : undefined)
      },
    },
    {
      title: "Favorite cycle",
      value: "model.cycle_favorite",
      keybind: "model_cycle_favorite",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.model.cycleFavorite(1)
      },
    },
    {
      title: "Favorite cycle reverse",
      value: "model.cycle_favorite_reverse",
      keybind: "model_cycle_favorite_reverse",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.model.cycleFavorite(-1)
      },
    },
    {
      title: "Switch agent",
      value: "agent.list",
      keybind: "agent_list",
      category: "Agent",
      onSelect: () => {
        dialog.replace(() => <DialogAgent />)
      },
    },
    {
      title: "Toggle MCPs",
      value: "mcp.list",
      category: "Agent",
      onSelect: () => {
        dialog.replace(() => <DialogMcp />)
      },
    },
    {
      title: "Agent cycle",
      value: "agent.cycle",
      keybind: "agent_cycle",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.agent.move(1)
      },
    },
    {
      title: "Agent cycle reverse",
      value: "agent.cycle.reverse",
      keybind: "agent_cycle_reverse",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.agent.move(-1)
      },
    },
    {
      title: "Connect provider",
      value: "provider.connect",
      suggested: !connected(),
      slash: { name: "connect" },
      onSelect: () => {
        dialog.replace(() => <DialogProviderList />)
      },
      category: "Provider",
    },
    {
      title: "View status",
      keybind: "status_view",
      value: "opencode.status",
      onSelect: () => {
        dialog.replace(() => <DialogStatus />)
      },
      category: "System",
    },
    {
      title: "Manage accounts",
      value: "account.manage",
      onSelect: () => {
        dialog.replace(() => <DialogAccount />)
      },
      category: "System",
    },
    {
      title: "Switch workspace",
      value: "workspace.switch",
      keybind: undefined,
      category: "System",
      slash: { name: "workspace" },
      onSelect: () => {
        dialog.replace(() => <DialogWorkspace />)
      },
    },
    {
      title: "Admin Panel",
      value: "admin.panel",
      keybind: "admin_panel" as const,
      category: "System",
      slash: { name: "admin" },
      onSelect: () => {
        debugCheckpoint("admin", "open panel")
        dialog.replace(() => <DialogAdmin />)
      },
    },
    {
      title: "Switch theme",
      value: "theme.switch",
      keybind: "theme_list",
      onSelect: () => {
        dialog.replace(() => <DialogThemeList />)
      },
      category: "System",
    },
    {
      title: "Toggle appearance",
      value: "theme.switch_mode",
      onSelect: (dialog) => {
        setMode(mode() === "dark" ? "light" : "dark")
        dialog.clear()
      },
      category: "System",
    },
    {
      title: "Command Palette",
      value: "command.list",
      slash: { name: "menu" },
      onSelect: () => {
        command.show()
      },
      category: "System",
    },
    {
      title: "Help",
      value: "help.show",
      onSelect: () => {
        dialog.replace(() => <DialogHelp />)
      },
      category: "System",
    },
    {
      title: "Open docs",
      value: "docs.open",
      onSelect: () => {
        open("https://opencode.ai/docs").catch(() => {})
        dialog.clear()
      },
      category: "System",
    },
    {
      title: "Exit the app",
      value: "app.exit",
      onSelect: () => exit(),
      category: "System",
    },
    {
      title: "Toggle debug panel",
      category: "System",
      value: "app.debug",
      onSelect: (dialog) => {
        renderer.toggleDebugOverlay()
        dialog.clear()
      },
    },
    {
      title: "Toggle console",
      category: "System",
      value: "app.console",
      onSelect: (dialog) => {
        renderer.console.toggle()
        dialog.clear()
      },
    },
    {
      title: "Write heap snapshot",
      category: "System",
      value: "app.heap_snapshot",
      onSelect: (dialog) => {
        const path = writeHeapSnapshot()
        toast.show({
          variant: "info",
          message: `Heap snapshot written to ${path}`,
          duration: 5000,
        })
        dialog.clear()
      },
    },
    {
      title: "Suspend terminal",
      value: "terminal.suspend",
      keybind: "terminal_suspend",
      category: "System",
      hidden: true,
      onSelect: () => {
        process.once("SIGCONT", () => {
          renderer.resume()
        })

        renderer.suspend()
        // pid=0 means send the signal to all processes in the process group
        process.kill(0, "SIGTSTP")
      },
    },
    {
      title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
      value: "terminal.title.toggle",
      keybind: "terminal_title_toggle",
      category: "System",
      onSelect: (dialog) => {
        setTerminalTitleEnabled((prev) => {
          const next = !prev
          kv.set("terminal_title_enabled", next)
          if (!next) renderer.setTerminalTitle("")
          return next
        })
        dialog.clear()
      },
    },
    {
      title: kv.get("animations_enabled", defaultAnimationsEnabled) ? "Disable animations" : "Enable animations",
      value: "app.toggle.animations",
      category: "System",
      onSelect: (dialog) => {
        kv.set("animations_enabled", !kv.get("animations_enabled", defaultAnimationsEnabled))
        dialog.clear()
      },
    },
    {
      title: kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
      value: "app.toggle.diffwrap",
      category: "System",
      onSelect: (dialog) => {
        const current = kv.get("diff_wrap_mode", "word")
        kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
        dialog.clear()
      },
    },
  ])

  createEffect(() => {
    const currentModel = local.model.current(route.data.type === "session" ? route.data.sessionID : undefined)
    if (!currentModel) return
    if (currentModel.providerId === "openrouter" && !kv.get("openrouter_warning", false)) {
      untrack(() => {
        DialogAlert.show(
          dialog,
          "Warning",
          "While openrouter is a convenient way to access LLMs your request will often be routed to subpar providers that do not work well in our testing.\n\nFor reliable access to models check out OpenCode Zen\nhttps://opencode.ai/zen",
        ).then(() => kv.set("openrouter_warning", true))
      })
    }
  })

  sdk.event.on(TuiEvent.CommandExecute.type, (evt) => {
    if (evt.properties.command === "account.manage") {
      dialog.replace(() => <DialogAccount />)
      return
    }
    command.trigger(evt.properties.command)
  })

  sdk.event.on(TuiEvent.ToastShow.type, (evt) => {
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  sdk.event.on(TuiEvent.SessionSelect.type, (evt) => {
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  sdk.event.on(SessionApi.Event.Deleted.type, (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  sdk.event.on(SessionApi.Event.Error.type, (evt) => {
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = (() => {
      if (!error) return "An error occurred"

      if (typeof error === "object") {
        const data = error.data
        if ("message" in data && typeof data.message === "string") {
          return data.message
        }
      }
      return String(error)
    })()

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  sdk.event.on(Installation.Event.UpdateAvailable.type, (evt) => {
    toast.show({
      variant: "info",
      title: "Update Available",
      message: `OpenCode v${evt.properties.version} is available. Run 'opencode upgrade' to update manually.`,
      duration: 10000,
    })
  })

  const safeWidth = () => {
    const measured = dimensions().width
    const fallback = process.stdout.columns ?? 80
    return Math.max(1, measured || fallback)
  }

  const safeHeight = () => {
    const measured = dimensions().height
    const fallback = process.stdout.rows ?? 24
    return Math.max(1, measured || fallback)
  }

  return (
    <box
      width={safeWidth()}
      height={safeHeight()}
      backgroundColor={theme.background}
      onMouseUp={async () => {
        if (Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) {
          renderer.clearSelection()
          return
        }
        const text = renderer.getSelection()?.getSelectedText()
        if (text && text.length > 0) {
          await Clipboard.copy(text)
            .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
            .catch(toast.error)
          renderer.clearSelection()
        }
      }}
    >
      <Switch>
        <Match when={route.data.type === "home"}>
          <Home />
        </Match>
        <Match when={route.data.type === "session"}>
          <Session />
        </Match>
      </Switch>
    </box>
  )
}

function ErrorComponent(props: {
  error: Error
  reset: () => void
  onExit: () => Promise<void>
  mode?: "dark" | "light"
}) {
  const term = useTerminalDimensions()
  const renderer = useRenderer()

  const handleExit = async () => {
    renderer.setTerminalTitle("")
    renderer.destroy()
    props.onExit()
  }

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      handleExit()
    }
  })
  const [copied, setCopied] = createSignal(false)

  const issueURL = new URL("https://github.com/anomalyco/opencode/issues/new?template=bug-report.yml")

  // Choose safe fallback colors per mode since theme context may not be available
  const isLight = props.mode === "light"
  const colors = {
    bg: isLight ? "#ffffff" : "#0a0a0a",
    text: isLight ? "#1a1a1a" : "#eeeeee",
    muted: isLight ? "#8a8a8a" : "#808080",
    primary: isLight ? "#3b7dd8" : "#fab283",
  }

  if (props.error.message) {
    issueURL.searchParams.set("title", `opentui: fatal: ${props.error.message}`)
  }

  if (props.error.stack) {
    issueURL.searchParams.set(
      "description",
      "```\n" + props.error.stack.substring(0, 6000 - issueURL.toString().length) + "...\n```",
    )
  }

  issueURL.searchParams.set("opencode-version", Installation.VERSION)

  const copyIssueURL = () => {
    Clipboard.copy(issueURL.toString()).then(() => {
      setCopied(true)
    })
  }

  return (
    <box flexDirection="column" gap={1} backgroundColor={colors.bg}>
      <box flexDirection="row" gap={1} alignItems="center">
        <text attributes={TextAttributes.BOLD} fg={colors.text}>
          Please report an issue.
        </text>
        <box onMouseUp={copyIssueURL} backgroundColor={colors.primary} padding={1}>
          <text attributes={TextAttributes.BOLD} fg={colors.bg}>
            Copy issue URL (exception info pre-filled)
          </text>
        </box>
        {copied() && <text fg={colors.muted}>Successfully copied</text>}
      </box>
      <box flexDirection="row" gap={2} alignItems="center">
        <text fg={colors.text}>A fatal error occurred!</text>
        <box onMouseUp={props.reset} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Reset TUI</text>
        </box>
        <box onMouseUp={handleExit} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Exit</text>
        </box>
      </box>
      <scrollbox height={Math.floor(term().height * 0.7)}>
        <text fg={colors.muted}>{props.error.stack}</text>
      </scrollbox>
      <text fg={colors.text}>{props.error.message}</text>
    </box>
  )
}
