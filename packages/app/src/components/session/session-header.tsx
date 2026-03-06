import { createEffect, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useTerminal } from "@/context/terminal"
import { getFilename } from "@opencode-ai/util/path"
import { decode64 } from "@/utils/base64"
import { Persist, persisted } from "@/utils/persist"

import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Keybind } from "@opencode-ai/ui/keybind"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"

const OPEN_APPS = [
  "vscode",
  "cursor",
  "zed",
  "textmate",
  "antigravity",
  "finder",
  "terminal",
  "iterm2",
  "ghostty",
  "xcode",
  "android-studio",
  "powershell",
  "sublime-text",
] as const

type OpenApp = (typeof OPEN_APPS)[number]
type OS = "macos" | "windows" | "linux" | "unknown"

const MAC_APPS = [
  { id: "vscode", label: "VS Code", icon: "vscode", openWith: "Visual Studio Code" },
  { id: "cursor", label: "Cursor", icon: "cursor", openWith: "Cursor" },
  { id: "zed", label: "Zed", icon: "zed", openWith: "Zed" },
  { id: "textmate", label: "TextMate", icon: "textmate", openWith: "TextMate" },
  { id: "antigravity", label: "Antigravity", icon: "antigravity", openWith: "Antigravity" },
  { id: "terminal", label: "Terminal", icon: "terminal", openWith: "Terminal" },
  { id: "iterm2", label: "iTerm2", icon: "iterm2", openWith: "iTerm" },
  { id: "ghostty", label: "Ghostty", icon: "ghostty", openWith: "Ghostty" },
  { id: "xcode", label: "Xcode", icon: "xcode", openWith: "Xcode" },
  { id: "android-studio", label: "Android Studio", icon: "android-studio", openWith: "Android Studio" },
  { id: "sublime-text", label: "Sublime Text", icon: "sublime-text", openWith: "Sublime Text" },
] as const

const WINDOWS_APPS = [
  { id: "vscode", label: "VS Code", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "Cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "Zed", icon: "zed", openWith: "zed" },
  { id: "powershell", label: "PowerShell", icon: "powershell", openWith: "powershell" },
  { id: "sublime-text", label: "Sublime Text", icon: "sublime-text", openWith: "Sublime Text" },
] as const

const LINUX_APPS = [
  { id: "vscode", label: "VS Code", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "Cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "Zed", icon: "zed", openWith: "zed" },
  { id: "sublime-text", label: "Sublime Text", icon: "sublime-text", openWith: "Sublime Text" },
] as const

type OpenOption = (typeof MAC_APPS)[number] | (typeof WINDOWS_APPS)[number] | (typeof LINUX_APPS)[number]
type OpenIcon = OpenApp | "file-explorer"
const OPEN_ICON_BASE = new Set<OpenIcon>(["finder", "vscode", "cursor", "zed"])

const openIconSize = (id: OpenIcon) => (OPEN_ICON_BASE.has(id) ? "size-4" : "size-[19px]")

const detectOS = (platform: ReturnType<typeof usePlatform>): OS => {
  if (platform.platform === "desktop" && platform.os) return platform.os
  if (typeof navigator !== "object") return "unknown"
  const value = navigator.platform || navigator.userAgent
  if (/Mac/i.test(value)) return "macos"
  if (/Win/i.test(value)) return "windows"
  if (/Linux/i.test(value)) return "linux"
  return "unknown"
}

const showRequestError = (language: ReturnType<typeof useLanguage>, err: unknown) => {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

export function SessionHeader() {
  const layout = useLayout()
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const command = useCommand()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const terminal = useTerminal()
  const largeScreen = createMediaQuery("(min-width: 1024px)")

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  })
  const name = createMemo(() => {
    const current = project()
    if (current) return current.name || getFilename(current.worktree)
    return getFilename(projectDirectory())
  })
  const hotkey = createMemo(() => command.keybind("file.open"))

  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const view = createMemo(() => layout.view(sessionKey))
  const os = createMemo(() => detectOS(platform))
  const sessionBasePath = createMemo(() =>
    params.id ? `/${params.dir}/session/${params.id}` : `/${params.dir}/session`,
  )
  const subpage = createMemo<"files" | "status" | "terminal" | undefined>(() => {
    const path = location.pathname
    const tool = path.match(/\/tool\/([^/]+)$/)?.[1]
    if (tool === "files") return "files"
    if (tool === "status" || tool === "todo" || tool === "monitor") return "status"
    if (path.endsWith("/terminal-popout")) return "terminal"
    return undefined
  })
  const subpageTitle = createMemo(() => {
    if (subpage() === "files") return language.t("session.tools.files")
    if (subpage() === "status") return language.t("status.popover.trigger")
    if (subpage() === "terminal") return language.t("session.tools.terminal")
    return undefined
  })

  const [exists, setExists] = createStore<Partial<Record<OpenApp, boolean>>>({ finder: true })

  const apps = createMemo(() => {
    if (os() === "macos") return MAC_APPS
    if (os() === "windows") return WINDOWS_APPS
    return LINUX_APPS
  })

  const fileManager = createMemo(() => {
    if (os() === "macos") return { label: "Finder", icon: "finder" as const }
    if (os() === "windows") return { label: "File Explorer", icon: "file-explorer" as const }
    return { label: "File Manager", icon: "finder" as const }
  })

  createEffect(() => {
    if (platform.platform !== "desktop") return
    if (!platform.checkAppExists) return

    const list = apps()

    setExists(Object.fromEntries(list.map((app) => [app.id, undefined])) as Partial<Record<OpenApp, boolean>>)

    void Promise.all(
      list.map((app) =>
        Promise.resolve(platform.checkAppExists?.(app.openWith))
          .then((value) => Boolean(value))
          .catch(() => false)
          .then((ok) => {
            console.debug(`[session-header] App "${app.label}" (${app.openWith}): ${ok ? "exists" : "does not exist"}`)
            return [app.id, ok] as const
          }),
      ),
    ).then((entries) => {
      setExists(Object.fromEntries(entries) as Partial<Record<OpenApp, boolean>>)
    })
  })

  const options = createMemo(() => {
    return [
      { id: "finder", label: fileManager().label, icon: fileManager().icon },
      ...apps().filter((app) => exists[app.id]),
    ] as const
  })

  const checksReady = createMemo(() => {
    if (platform.platform !== "desktop") return true
    if (!platform.checkAppExists) return true
    const list = apps()
    return list.every((app) => exists[app.id] !== undefined)
  })

  const [prefs, setPrefs] = persisted(Persist.global("open.app"), createStore({ app: "finder" as OpenApp }))
  const [menu, setMenu] = createStore({ open: false })
  const [openRequest, setOpenRequest] = createStore({
    app: undefined as OpenApp | undefined,
  })

  const canOpen = createMemo(() => platform.platform === "desktop" && !!platform.openPath && server.isLocal())
  const current = createMemo(() => options().find((o) => o.id === prefs.app) ?? options()[0])
  const opening = createMemo(() => openRequest.app !== undefined)

  createEffect(() => {
    if (platform.platform !== "desktop") return
    if (!checksReady()) return
    const value = prefs.app
    if (options().some((o) => o.id === value)) return
    setPrefs("app", options()[0]?.id ?? "finder")
  })

  const openDir = (app: OpenApp) => {
    if (opening() || !canOpen() || !platform.openPath) return
    const directory = projectDirectory()
    if (!directory) return

    const item = options().find((o) => o.id === app)
    const openWith = item && "openWith" in item ? item.openWith : undefined
    setOpenRequest("app", app)
    platform
      .openPath(directory, openWith)
      .catch((err: unknown) => showRequestError(language, err))
      .finally(() => {
        setOpenRequest("app", undefined)
      })
  }

  const openTerminalPage = () => {
    const active = terminal.active() ?? terminal.all()[0]?.id
    const next = new URL(`${sessionBasePath()}/terminal-popout`, window.location.origin)
    if (active) next.searchParams.set("pty", active)
    navigate(`${next.pathname}${next.search}`)
  }

  const openToolPage = (tool: "files" | "status") => {
    navigate(`${sessionBasePath()}/tool/${tool}`)
  }

  const toggleDesktopPanel = (mode: "files" | "status") => {
    if (layout.fileTree.opened() && layout.fileTree.mode() === mode) {
      layout.fileTree.close()
      return
    }
    layout.fileTree.show(mode)
  }

  const toggleDesktopTerminal = () => {
    if (view().terminal.opened()) {
      view().terminal.close()
      return
    }
    view().terminal.open()
  }

  const toggleMobileReview = () => {
    if (subpage()) {
      view().reviewPanel.open()
      navigate(sessionBasePath())
      return
    }
    view().reviewPanel.toggle()
  }

  const toggleMobileTool = (tool: "files" | "status" | "terminal") => {
    if (subpage() === tool) {
      navigate(sessionBasePath())
      return
    }
    view().reviewPanel.close()
    if (tool === "terminal") {
      openTerminalPage()
      return
    }
    openToolPage(tool)
  }

  const desktopActiveTool = createMemo<"status" | "files" | "terminal" | undefined>(() => {
    if (view().terminal.opened()) return "terminal"
    if (!layout.fileTree.opened()) return undefined
    return layout.fileTree.mode()
  })

  const mobileActiveTool = createMemo<"changes" | "files" | "status" | "terminal" | undefined>(() => {
    if (subpage()) return subpage()
    if (view().reviewPanel.opened()) return "changes"
    return undefined
  })
  const desktopNavButtonClass = (active: boolean) =>
    `h-[24px] rounded-md border px-2.5 gap-1.5 shadow-none ${
      active
        ? "border-border-base bg-surface-raised-base-active text-text-base"
        : "border-border-base bg-surface-panel text-text-strong hover:bg-surface-raised-base-hover"
    }`
  const mobileNavButtonClass = (active: boolean) =>
    `size-6 p-0 rounded-md border shadow-none ${
      active
        ? "border-border-base bg-surface-raised-base-active text-text-base"
        : "border-border-base bg-surface-panel text-text-strong hover:bg-surface-raised-base-hover"
    }`

  const leftMount = createMemo(
    () => document.getElementById("opencode-titlebar-left") ?? document.getElementById("opencode-titlebar-center"),
  )
  const rightMount = createMemo(() => document.getElementById("opencode-titlebar-right"))

  return (
    <>
      <Show when={leftMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <Show
              when={subpageTitle()}
              fallback={
                <button
                  type="button"
                  class="hidden md:flex w-[320px] max-w-full min-w-0 h-[24px] px-2 pl-1.5 items-center gap-2 justify-between rounded-md border border-border-base bg-surface-panel transition-colors cursor-default hover:bg-surface-raised-base-hover focus-visible:bg-surface-raised-base-hover active:bg-surface-raised-base-active"
                  onClick={() => command.trigger("file.open")}
                  aria-label={language.t("session.header.searchFiles")}
                >
                  <div class="flex min-w-0 flex-1 items-center gap-2 overflow-visible">
                    <Icon name="magnifying-glass" size="normal" class="icon-base shrink-0" />
                    <span class="flex-1 min-w-0 text-14-regular text-text-weak truncate h-4.5 flex items-center">
                      {language.t("session.header.search.placeholder", { project: name() })}
                    </span>
                  </div>

                  <Show when={hotkey()}>
                    {(keybind) => (
                      <Keybind class="shrink-0 !border-0 !bg-transparent !shadow-none px-0">{keybind()}</Keybind>
                    )}
                  </Show>
                </button>
              }
            >
              {(title) => (
                <button
                  type="button"
                  class="flex max-w-full min-w-0 h-[24px] px-2 items-center text-14-medium text-text-weak truncate"
                  onClick={() => navigate(sessionBasePath())}
                  aria-label={language.t("common.close")}
                >
                  {title()}
                </button>
              )}
            </Show>
          </Portal>
        )}
      </Show>
      <Show when={rightMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="flex items-center gap-3">
              <Show when={projectDirectory() && canOpen()}>
                <div class="hidden xl:flex items-center">
                  <div class="flex items-center">
                    <div class="flex h-[24px] box-border items-center rounded-md border border-border-base bg-surface-panel overflow-hidden">
                      <Button
                        variant="ghost"
                        class="rounded-none h-full py-0 pr-3 pl-2 gap-1.5 border-none shadow-none disabled:!cursor-default"
                        classList={{
                          "bg-surface-raised-base-active": opening(),
                        }}
                        onClick={() => openDir(current().id)}
                        disabled={opening()}
                        aria-label={language.t("session.header.open.ariaLabel", { app: current().label })}
                      >
                        <div class="flex size-5 shrink-0 items-center justify-center">
                          <Show
                            when={opening()}
                            fallback={<AppIcon id={current().icon} class={openIconSize(current().icon)} />}
                          >
                            <Spinner class="size-3.5 text-icon-base" />
                          </Show>
                        </div>
                        <span class="text-12-regular text-text-strong">Open</span>
                      </Button>
                      <div class="self-stretch w-px bg-border-base/70" />
                      <DropdownMenu
                        gutter={6}
                        placement="bottom-end"
                        open={menu.open}
                        onOpenChange={(open) => setMenu("open", open)}
                      >
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="chevron-down"
                          variant="ghost"
                          disabled={opening()}
                          class="rounded-none h-full w-[24px] p-0 border-none shadow-none data-[expanded]:bg-surface-raised-base-active disabled:!cursor-default"
                          classList={{
                            "bg-surface-raised-base-active": opening(),
                          }}
                          aria-label={language.t("session.header.open.menu")}
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content>
                            <DropdownMenu.Group>
                              <DropdownMenu.GroupLabel>{language.t("session.header.openIn")}</DropdownMenu.GroupLabel>
                              <DropdownMenu.RadioGroup
                                value={prefs.app}
                                onChange={(value) => {
                                  if (!OPEN_APPS.includes(value as OpenApp)) return
                                  setPrefs("app", value as OpenApp)
                                }}
                              >
                                <For each={options()}>
                                  {(o) => (
                                    <DropdownMenu.RadioItem
                                      value={o.id}
                                      disabled={opening()}
                                      onSelect={() => {
                                        setMenu("open", false)
                                        openDir(o.id)
                                      }}
                                    >
                                      <div class="flex size-5 shrink-0 items-center justify-center">
                                        <AppIcon id={o.icon} class={openIconSize(o.icon)} />
                                      </div>
                                      <DropdownMenu.ItemLabel>{o.label}</DropdownMenu.ItemLabel>
                                      <DropdownMenu.ItemIndicator>
                                        <Icon name="check-small" size="small" class="text-icon-weak" />
                                      </DropdownMenu.ItemIndicator>
                                    </DropdownMenu.RadioItem>
                                  )}
                                </For>
                              </DropdownMenu.RadioGroup>
                            </DropdownMenu.Group>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              </Show>
              <Show
                when={largeScreen()}
                fallback={
                  <div class="flex items-center gap-3 ml-2 shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      class={mobileNavButtonClass(mobileActiveTool() === "changes")}
                      onClick={toggleMobileReview}
                      aria-label={language.t("command.review.toggle")}
                    >
                      <div class="relative flex items-center justify-center size-4 [&>*]:absolute [&>*]:inset-0">
                        <Icon
                          size="small"
                          name={mobileActiveTool() === "changes" ? "layout-right-full" : "layout-right"}
                          class="group-hover/review-toggle:hidden"
                        />
                      </div>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      class={mobileNavButtonClass(mobileActiveTool() === "status")}
                      onClick={() => toggleMobileTool("status")}
                      aria-label={language.t("status.popover.trigger")}
                    >
                      <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M3 8h2.5M6.5 8h2M10.5 8H13" stroke-linecap="round" />
                        <circle cx="8" cy="8" r="5.25" />
                        <path d="M8 5.25v5.5" stroke-linecap="round" />
                      </svg>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      class={mobileNavButtonClass(mobileActiveTool() === "files")}
                      onClick={() => toggleMobileTool("files")}
                      aria-label={language.t("session.tools.files")}
                    >
                      <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M2.75 4.25h4l1 1.5h5.5v6a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1z" stroke-linejoin="round" />
                        <path d="M2.75 4.25v-1a1 1 0 0 1 1-1h2.3c.3 0 .58.14.77.38l.93 1.12" stroke-linecap="round" />
                      </svg>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      class={mobileNavButtonClass(mobileActiveTool() === "terminal")}
                      onClick={() => toggleMobileTool("terminal")}
                      aria-label={language.t("session.tools.terminal")}
                    >
                      <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M3.25 4.5 6.5 7.75 3.25 11" stroke-linecap="round" stroke-linejoin="round" />
                        <path d="M8 11h4.75" stroke-linecap="round" />
                        <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" />
                      </svg>
                    </Button>
                  </div>
                }
              >
                <div class="flex items-center gap-3 ml-2 shrink-0">
                  <div class="hidden lg:block shrink-0">
                    <TooltipKeybind
                      title={language.t("command.review.toggle")}
                      keybind={command.keybind("review.toggle")}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        class={`${desktopNavButtonClass(view().reviewPanel.opened())} group/review-toggle`}
                        onClick={() => view().reviewPanel.toggle()}
                        aria-label={language.t("command.review.toggle")}
                        aria-expanded={view().reviewPanel.opened()}
                        aria-controls="review-panel"
                      >
                        <div class="relative flex items-center justify-center size-4 shrink-0 [&>*]:absolute [&>*]:inset-0">
                          <Icon
                            size="small"
                            name={view().reviewPanel.opened() ? "layout-right-full" : "layout-right"}
                            class="group-hover/review-toggle:hidden"
                          />
                          <Icon
                            size="small"
                            name="layout-right-partial"
                            class="hidden group-hover/review-toggle:inline-block"
                          />
                          <Icon
                            size="small"
                            name={view().reviewPanel.opened() ? "layout-right" : "layout-right-full"}
                            class="hidden group-active/review-toggle:inline-block"
                          />
                        </div>
                      </Button>
                    </TooltipKeybind>
                  </div>
                  <Tooltip value={language.t("status.popover.trigger")}>
                    <Button
                      type="button"
                      variant="ghost"
                      class={desktopNavButtonClass(desktopActiveTool() === "status")}
                      onClick={() => toggleDesktopPanel("status")}
                      aria-label={language.t("status.popover.trigger")}
                    >
                      <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M3 8h2.5M6.5 8h2M10.5 8H13" stroke-linecap="round" />
                        <circle cx="8" cy="8" r="5.25" />
                        <path d="M8 5.25v5.5" stroke-linecap="round" />
                      </svg>
                    </Button>
                  </Tooltip>
                  <TooltipKeybind
                    title={language.t("command.fileTree.toggle")}
                    keybind={command.keybind("fileTree.toggle")}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      class={desktopNavButtonClass(desktopActiveTool() === "files")}
                      onClick={() => toggleDesktopPanel("files")}
                      aria-label={language.t("session.tools.files")}
                    >
                      <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M2.75 4.25h4l1 1.5h5.5v6a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1z" stroke-linejoin="round" />
                        <path d="M2.75 4.25v-1a1 1 0 0 1 1-1h2.3c.3 0 .58.14.77.38l.93 1.12" stroke-linecap="round" />
                      </svg>
                    </Button>
                  </TooltipKeybind>
                  <Tooltip value={language.t("session.tools.terminal")}>
                    <Button
                      type="button"
                      variant="ghost"
                      class={desktopNavButtonClass(desktopActiveTool() === "terminal")}
                      onClick={toggleDesktopTerminal}
                      aria-label={language.t("session.tools.terminal")}
                    >
                      <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M3.25 4.5 6.5 7.75 3.25 11" stroke-linecap="round" stroke-linejoin="round" />
                        <path d="M8 11h4.75" stroke-linecap="round" />
                        <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" />
                      </svg>
                    </Button>
                  </Tooltip>
                </div>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}
