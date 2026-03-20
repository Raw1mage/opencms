import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createMemo, createResource, createSignal, onMount, Show } from "solid-js"
import { Locale } from "@/util/locale"
import { Keybind } from "@/util/keybind"
import { useKeybind } from "../context/keybind"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { DialogSessionRename } from "./dialog-session-rename"
import { useKV } from "../context/kv"
import { createDebouncedSignal } from "../util/signal"
import path from "path"
import "opentui-spinner/solid"

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const sdk = useSDK()
  const kv = useKV()
  const defaultAnimationsEnabled = process.env.TERM_PROGRAM === "vscode" || process.env.VSCODE_PID ? false : true

  const [search, setSearch] = createDebouncedSignal("", 150)
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())

  const toggleExpand = (sessionID: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(sessionID)) next.delete(sessionID)
      else next.add(sessionID)
      return next
    })
  }

  const [searchResults] = createResource(search, async (query) => {
    if (!query) return undefined
    const result = await sdk.client.session.list({ search: query, limit: 30 })
    return result.data ?? []
  })

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

  const sessions = createMemo(() => searchResults() ?? sync.data.session)

  function projectLabel(session: {
    directory?: string
    project?: { name?: string | null; worktree?: string | null } | null
  }): string {
    const name = session.project?.name?.trim()
    if (name) return name
    if (session.directory) {
      const base = path.basename(path.resolve(session.directory))
      if (base && base !== "/" && base !== ".") return base
    }
    return ""
  }

  const sessionLabel = (
    session: {
      title: string
      projectID: string
      directory?: string
      project?: { name?: string | null; worktree?: string | null } | null
    },
    childCount = 0,
    titlePrefix = "",
    isRoot = false,
  ) => {
    const proj = isRoot ? projectLabel(session) : ""
    const projPrefix = proj ? `[${proj}] ` : ""
    const childSuffix = childCount > 0 ? ` [${childCount}]` : ""
    return `${titlePrefix}${projPrefix}${session.title}${childSuffix}`
  }

  const options = createMemo(() => {
    const today = new Date().toDateString()
    const allSessions = sessions()

    // Build a map of parentID -> children
    const childrenMap = new Map<string, typeof allSessions>()
    for (const s of allSessions) {
      if (s.parentID) {
        const children = childrenMap.get(s.parentID) ?? []
        children.push(s)
        childrenMap.set(s.parentID, children)
      }
    }

    // Get root sessions (no parentID)
    const roots = allSessions.filter((x) => !x.parentID).toSorted((a, b) => b.time.updated - a.time.updated)

    const result: Array<{
      title: string
      value: string
      category: string
      footer: string
      gutter?: any
    }> = []

    for (const root of roots) {
      const date = new Date(root.time.updated)
      let category = date.toDateString()
      if (category === today) {
        category = "Today"
      }
      const status = sync.data.session_status?.[root.id]
      const isWorking = status?.type === "busy"
      const children = childrenMap.get(root.id) ?? []

      const isExpanded = expanded().has(root.id)
      const arrow = children.length > 0 ? (isExpanded ? "▾ " : "▸ ") : "  "

      // Add root session with child count indicator and project prefix
      result.push({
        title: `${arrow}${sessionLabel(root, children.length, "", true)}`,
        value: root.id,
        category,
        footer: Locale.time(root.time.updated),
        gutter: isWorking ? (
          <Show
            when={kv.get("animations_enabled", defaultAnimationsEnabled)}
            fallback={<text fg={theme.textMuted}>[⋯]</text>}
          >
            <spinner frames={spinnerFrames} interval={80} color={theme.primary} />
          </Show>
        ) : undefined,
      })

      // Add children with tree prefix (only when expanded)
      if (isExpanded) {
        const sortedChildren = children.toSorted((a, b) => a.time.created - b.time.created)
        for (let i = 0; i < sortedChildren.length; i++) {
          const child = sortedChildren[i]
          const isLast = i === sortedChildren.length - 1
          const prefix = isLast ? "  └─ " : "  ├─ "
          const childStatus = sync.data.session_status?.[child.id]
          const childWorking = childStatus?.type === "busy"

          result.push({
            title: sessionLabel(child, 0, prefix),
            value: child.id,
            category, // Same category as parent
            footer: Locale.time(child.time.updated),
            gutter: childWorking ? (
              <Show
                when={kv.get("animations_enabled", defaultAnimationsEnabled)}
                fallback={<text fg={theme.textMuted}>[⋯]</text>}
              >
                <spinner frames={spinnerFrames} interval={80} color={theme.accent} />
              </Show>
            ) : undefined,
          })
        }
      }
    }

    return result
  })

  // Map child session IDs to their root parent for toggle
  const childToRoot = createMemo(() => {
    const map = new Map<string, string>()
    const allSessions = sessions()
    for (const s of allSessions) {
      if (s.parentID) map.set(s.id, s.parentID)
    }
    return map
  })

  // Navigation: left key closes dialog
  const goBack = () => {
    dialog.clear()
  }

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Sessions"
      options={options()}
      skipFilter={true}
      current={currentSessionID()}
      onFilter={setSearch}
      onSelect={(option) => {
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
        dialog.clear()
      }}
      keybind={[
        {
          keybind: Keybind.parse("space")[0],
          title: "(Space) Toggle subs",
          label: "",
          hidden: true,
          onTrigger: (option) => {
            if (!option) return
            // If selected is a child, toggle its parent; if root, toggle itself
            const rootID = childToRoot().get(option.value) ?? option.value
            toggleExpand(rootID)
          },
        },
        {
          keybind: Keybind.parse("delete")[0],
          title: "(Del)ete",
          label: "",
          onTrigger: async (option) => {
            if (!option) return
            sdk.client.session.delete({
              sessionID: option.value,
            })
          },
        },
        {
          keybind: keybind.all.session_rename?.[0],
          title: "rename",
          onTrigger: async (option) => {
            if (!option) return
            dialog.replace(() => <DialogSessionRename session={option.value} />)
          },
        },
        {
          keybind: Keybind.parse("r")[0],
          title: "(R)efresh",
          label: "",
          onTrigger: async () => {
            await sync.bootstrap()
          },
        },
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
