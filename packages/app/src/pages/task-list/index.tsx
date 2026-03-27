import { createSignal, createEffect, onMount, Show, type ParentProps } from "solid-js"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { DataProvider } from "@opencode-ai/ui/context"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { DiffComponentProvider } from "@opencode-ai/ui/context/diff"
import { CodeComponentProvider } from "@opencode-ai/ui/context/code"
import { Diff } from "@opencode-ai/ui/diff"
import { Code } from "@opencode-ai/ui/code"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLayout } from "@/context/layout"
import { TaskDetail } from "./task-detail"

/**
 * Bridge that connects the virtual-project SyncProvider store to DataProvider,
 * so SessionTurn and other UI components can read session data via useData().
 */
function TaskDataBridge(props: ParentProps<{ directory: string }>) {
  const sync = useSync()
  const sdk = useSDK()
  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onPermissionRespond={(input) => sdk.client.permission.respond(input)}
      onSyncSession={(sessionID) => sync.session.sync(sessionID)}
    >
      {props.children}
    </DataProvider>
  )
}

/**
 * Provides MarkedProvider + DiffComponentProvider + CodeComponentProvider
 * needed by SessionTurn for rendering markdown, diffs, and code blocks.
 */
function TaskRichContentProviders(props: ParentProps) {
  const platform = usePlatform()
  return (
    <MarkedProvider nativeParser={platform.parseMarkdown}>
      <DiffComponentProvider component={Diff}>
        <CodeComponentProvider component={Code}>{props.children}</CodeComponentProvider>
      </DiffComponentProvider>
    </MarkedProvider>
  )
}

export default function TaskListPage() {
  const globalSDK = useGlobalSDK()
  const layout = useLayout()
  const [virtualDir, setVirtualDir] = createSignal("")

  onMount(() => {
    layout.sidebar.open()
    layout.mobileSidebar.show()
  })

  createEffect(() => {
    void globalSDK
      .fetch(`${globalSDK.url}/api/v2/cron/project`)
      .then((res) => res.json() as Promise<{ directory: string }>)
      .then((data) => setVirtualDir(data.directory))
      .catch(() => {})
  })

  return (
    <Show
      when={virtualDir()}
      fallback={
        <div class="size-full flex items-center justify-center text-color-dimmed text-13-medium">
          Connecting to task manager...
        </div>
      }
    >
      <SDKProvider directory={virtualDir}>
        <SyncProvider>
          <TaskDataBridge directory={virtualDir()}>
            <TaskRichContentProviders>
              <div class="size-full flex overflow-hidden">
                <div class="flex-1 min-w-0">
                  <TaskDetail />
                </div>
              </div>
            </TaskRichContentProviders>
          </TaskDataBridge>
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}
