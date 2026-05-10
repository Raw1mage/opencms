import "@/index.css"
import { ErrorBoundary, Show, Suspense, lazy, type JSX, type ParentProps } from "solid-js"
import { Router, Route, Navigate, useNavigate } from "@solidjs/router"
import { createEffect, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { base64Encode } from "@opencode-ai/util/encode"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@opencode-ai/ui/font"
import { I18nProvider } from "@opencode-ai/ui/context"
import { ThemeProvider } from "@opencode-ai/ui/theme"
import { GlobalSyncProvider } from "@/context/global-sync"
import { PermissionProvider } from "@/context/permission"
import { LayoutProvider } from "@/context/layout"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { normalizeServerUrl, ServerProvider, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import { PromptProvider } from "@/context/prompt"
import { FileProvider } from "@/context/file"
import { CommentsProvider } from "@/context/comments"
import { NotificationProvider } from "@/context/notification"
import { ModelsProvider } from "@/context/models"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { CommandProvider } from "@/context/command"
import { LanguageProvider, useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { HighlightsProvider } from "@/context/highlights"
import { PromptsProvider, PromptsLayer } from "@/context/prompts"
import { WebAuthProvider } from "@/context/web-auth"
import Layout from "@/pages/layout"
import DirectoryLayout from "@/pages/directory-layout"
import { ErrorPage } from "./pages/error"
import { AuthGate } from "@/components/auth-gate"
const Home = lazy(() => import("@/pages/home"))
const Session = lazy(() => import("@/pages/session"))
const TerminalPopout = lazy(() => import("@/pages/session/terminal-popout"))
const FileExplorerPopout = lazy(() => import("@/pages/session/file-explorer-popout"))
const FileViewPopout = lazy(() => import("@/pages/session/file-view-popout"))
const SessionToolPage = lazy(() => import("@/pages/session/tool-page"))
const SessionRichContentProvider = lazy(() => import("@/pages/session/session-rich-content-provider"))
const TaskList = lazy(() => import("@/pages/task-list"))
const Loading = () => <div class="size-full" />

const HomeRoute = () => (
  <Suspense fallback={<Loading />}>
    <Home />
  </Suspense>
)

const SessionRoute = () => (
  <SessionProviders>
    <Suspense fallback={<Loading />}>
      <SessionRichContentProvider>
        <Session />
      </SessionRichContentProvider>
    </Suspense>
  </SessionProviders>
)

const TerminalPopoutRoute = () => (
  <SessionProviders>
    <Suspense fallback={<Loading />}>
      <SessionRichContentProvider>
        <TerminalPopout />
      </SessionRichContentProvider>
    </Suspense>
  </SessionProviders>
)

const FileExplorerPopoutRoute = () => (
  <SessionProviders>
    <Suspense fallback={<Loading />}>
      <SessionRichContentProvider>
        <FileExplorerPopout />
      </SessionRichContentProvider>
    </Suspense>
  </SessionProviders>
)

const FileViewPopoutRoute = () => (
  <SessionProviders>
    <Suspense fallback={<Loading />}>
      <SessionRichContentProvider>
        <FileViewPopout />
      </SessionRichContentProvider>
    </Suspense>
  </SessionProviders>
)

const SessionToolRoute = () => (
  <SessionProviders>
    <Suspense fallback={<Loading />}>
      <SessionRichContentProvider>
        <SessionToolPage />
      </SessionRichContentProvider>
    </Suspense>
  </SessionProviders>
)

const SessionIndexRoute = () => <Navigate href="session" />

const TaskListRoute = () => (
  <Suspense fallback={<Loading />}>
    <TaskList />
  </Suspense>
)


function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.locale, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
      serverPassword?: string
    }
  }
}

function AppShellProviders(props: ParentProps) {
  return (
    <SettingsProvider>
      <PermissionProvider>
        <LayoutProvider>
          <NotificationProvider>
            <ModelsProvider>
              <CommandProvider>
                <HighlightsProvider>
                  <PromptsProvider>
                    <Layout>{props.children}</Layout>
                    <PromptsLayer />
                  </PromptsProvider>
                </HighlightsProvider>
              </CommandProvider>
            </ModelsProvider>
          </NotificationProvider>
        </LayoutProvider>
      </PermissionProvider>
    </SettingsProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function RouterRoot(props: ParentProps<{ appChildren?: JSX.Element }>) {
  return (
    <AppShellProviders>
      <WebSessionSelectBridge />
      {props.appChildren}
      {props.children}
    </AppShellProviders>
  )
}

function WebSessionSelectBridge() {
  const globalSDK = useGlobalSDK()
  const navigate = useNavigate()

  createEffect(() => {
    const unsub = globalSDK.event.listen((e) => {
      const event = e.details
      if (event?.type !== "tui.session.select") return
      const sessionID = (event.properties as any)?.sessionID
      if (typeof sessionID !== "string" || !sessionID) return
      void (async () => {
        try {
          const session = await globalSDK.client.session.get({ sessionID })
          const directory = session.data?.directory
          if (!directory) return
          navigate(`/${base64Encode(directory)}/session/${sessionID}`)
        } catch {
          // ignore failed external session selection
        }
      })()
    })
    onCleanup(() => unsub())
  })

  return null
}

const getStoredDefaultServerUrl = (platform: ReturnType<typeof usePlatform>) => {
  if (platform.platform !== "web") return
  const result = platform.getDefaultServerUrl?.()
  if (result instanceof Promise) return
  if (!result) return
  return normalizeServerUrl(result)
}

const isLocalHost = (host: string) => {
  const value = host.trim().toLowerCase()
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]"
}

const hostnameOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

const resolveDefaultServerUrl = (props: {
  defaultUrl?: string
  storedDefaultServerUrl?: string
  hostname: string
  origin: string
  isDev: boolean
  devHost?: string
  devPort?: string
}) => {
  if (props.defaultUrl) return props.defaultUrl
  if (props.storedDefaultServerUrl) {
    const currentIsLocal = isLocalHost(props.hostname)
    const storedHost = hostnameOf(props.storedDefaultServerUrl)
    const storedIsLocal = storedHost ? isLocalHost(storedHost) : false

    // Web deployment safety: when app is opened from a non-local domain
    // (e.g. reverse proxy), ignore stale persisted localhost target.
    if (!props.isDev && !currentIsLocal && storedIsLocal) return props.origin
    return props.storedDefaultServerUrl
  }
  if (props.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (props.isDev) return `http://${props.devHost ?? "localhost"}:${props.devPort ?? "4096"}`
  return props.origin
}

export function AppBaseProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <LanguageProvider>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <DialogProvider>{props.children}</DialogProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.url} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: { defaultUrl?: string; children?: JSX.Element; isSidecar?: boolean }) {
  const platform = usePlatform()
  const storedDefaultServerUrl = getStoredDefaultServerUrl(platform)
  const defaultServerUrl = resolveDefaultServerUrl({
    defaultUrl: props.defaultUrl,
    storedDefaultServerUrl,
    hostname: location.hostname,
    origin: window.location.origin,
    isDev: import.meta.env.DEV,
    devHost: import.meta.env.VITE_OPENCODE_SERVER_HOST,
    devPort: import.meta.env.VITE_OPENCODE_SERVER_PORT,
  })

  return (
    <ServerProvider defaultUrl={defaultServerUrl} isSidecar={props.isSidecar}>
      <WebAuthProvider>
        <AuthGate>
          <ServerKey>
            <GlobalSDKProvider>
              <GlobalSyncProvider>
                <Router
                  root={(routerProps) => <RouterRoot appChildren={props.children}>{routerProps.children}</RouterRoot>}
                >
                  <Route path="/" component={HomeRoute} />
                  <Route path="/system/tasks/:jobId?" component={TaskListRoute} />
                  <Route path="/:dir" component={DirectoryLayout}>
                    <Route path="/" component={SessionIndexRoute} />
                    <Route path="/session/:id?" component={SessionRoute} />
                    <Route path="/session/:id?/tool/:tool" component={SessionToolRoute} />
                    <Route path="/session/:id?/terminal-popout" component={TerminalPopoutRoute} />
                    <Route path="/session/:id?/file-explorer-popout" component={FileExplorerPopoutRoute} />
                    <Route path="/session/:id?/file-view-popout" component={FileViewPopoutRoute} />
                  </Route>
                </Router>
              </GlobalSyncProvider>
            </GlobalSDKProvider>
          </ServerKey>
        </AuthGate>
      </WebAuthProvider>
    </ServerProvider>
  )
}
