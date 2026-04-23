import { createEffect, createMemo, Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider } from "@/context/local"

import { DataProvider } from "@opencode-ai/ui/context"
import type { QuestionAnswer } from "@opencode-ai/sdk/v2"
import { decode64 } from "@/utils/base64"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { buildCanonicalDirectoryHref } from "./directory-layout-path"

function DirectoryDataProvider(props: ParentProps<{ directory: string }>) {
  const params = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const sync = useSync()
  const sdk = useSDK()

  createEffect(() => {
    if (!params.dir) return
    if (!sync.ready) return
    if (!sync.directory) return
    if (sync.directory === props.directory) return
    const next = buildCanonicalDirectoryHref({
      pathname: location.pathname,
      dirParam: params.dir,
      resolvedDirectory: sync.directory,
      search: location.search,
      hash: location.hash,
    })
    if (!next) return
    const current = `${location.pathname}${location.search}${location.hash}`
    if (next === current) return
    navigate(next, { replace: true })
  })

  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onPermissionRespond={(input: {
        sessionID: string
        permissionID: string
        response: "once" | "always" | "reject"
      }) => sdk.client.permission.respond(input)}
      onQuestionReply={(input: { requestID: string; answers: QuestionAnswer[] }) => sdk.client.question.reply(input)}
      onQuestionReject={(input: { requestID: string }) => sdk.client.question.reject(input)}
      onNavigateToSession={(sessionID: string) => navigate(`/${params.dir}/session/${sessionID}`)}
      onSessionHref={(sessionID: string) => `/${params.dir}/session/${sessionID}`}
      onSyncSession={(sessionID: string) => sync.session.sync(sessionID)}
      onExpandPart={async (input: { sessionID: string; messageID: string; partID: string }) => {
        // Scoped fetch for one part (mobile-tail-first-simplification DD-6).
        // Replaces the old syncSession() full-session refetch.
        const url = `${sdk.url}/api/v2/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}/part/${encodeURIComponent(input.partID)}?directory=${encodeURIComponent(props.directory)}`
        const response = await sdk.fetch(url)
        if (!response.ok) return
        const body = (await response.json()) as { part?: unknown }
        const fullPart = body?.part as { id: string } | undefined
        if (!fullPart?.id) return
        sync.patchPart(input.messageID, fullPart)
      }}
    >
      <LocalProvider>{props.children}</LocalProvider>
    </DataProvider>
  )
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const navigate = useNavigate()
  const language = useLanguage()
  const [store, setStore] = createStore({ invalid: "" })
  const directory = createMemo(() => {
    return decode64(params.dir) ?? ""
  })

  createEffect(() => {
    if (!params.dir) return
    if (directory()) return
    if (store.invalid === params.dir) return
    setStore("invalid", params.dir)
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })
  return (
    <Show when={directory()}>
      <SDKProvider directory={directory}>
        <SyncProvider>
          <DirectoryDataProvider directory={directory()}>{props.children}</DirectoryDataProvider>
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}
