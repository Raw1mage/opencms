import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { createMemo, createResource, onMount } from "solid-js"
import { Keybind } from "@/util/keybind"

export function DialogWorkspace() {
  const dialog = useDialog()
  const sdk = useSDK()

  const [projects] = createResource(async () => {
    const result = await sdk.client.project.list()
    return result.data ?? []
  })

  const options = createMemo(() => {
    const list = projects() ?? []
    return list
      .filter((p) => p.worktree && p.worktree !== "/")
      .toSorted((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .map((p) => ({
        title: p.name || p.worktree,
        value: p.worktree,
        footer: p.name ? p.worktree : "",
        category: "Workspaces",
      }))
  })

  const goBack = () => {
    dialog.clear()
  }

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Switch Workspace"
      options={options()}
      current={sdk.directory}
      onSelect={(option) => {
        sdk.switchDirectory(option.value)
        dialog.clear()
      }}
      keybind={[
        {
          keybind: Keybind.parse("left")[0],
          title: "(←)Exit",
          label: "",
          hidden: false,
          onTrigger: goBack,
        },
        {
          keybind: Keybind.parse("esc")[0],
          title: "",
          hidden: true,
          onTrigger: goBack,
        },
      ]}
    />
  )
}
