import { createResource, Show, type ParentProps } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { SDKProvider } from "@/context/sdk"
import { SyncProvider } from "@/context/sync"

/**
 * Layout for /system/tasks routes.
 *
 * Fetches the virtual tasks project directory from GET /api/v2/cron/project,
 * then wraps children in SDKProvider + SyncProvider scoped to that directory.
 * This makes the virtual project's sessions available through the normal
 * GlobalSync child store mechanism.
 */
export default function TasksLayout(props: ParentProps) {
  const globalSDK = useGlobalSDK()

  const [directory] = createResource(
    () => globalSDK.url,
    async (url) => {
      const res = await globalSDK.fetch(`${url}/api/v2/cron/project`)
      if (!res.ok) throw new Error("Failed to fetch cron project directory")
      const data = (await res.json()) as { directory: string }
      return data.directory
    },
  )

  return (
    <Show when={directory()}>
      {(dir) => (
        <SDKProvider directory={dir}>
          <SyncProvider>{props.children}</SyncProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
