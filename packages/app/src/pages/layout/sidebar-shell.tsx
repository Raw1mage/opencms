import { createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { useLocation } from "@solidjs/router"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { type LocalProject } from "@/context/layout"
import { sidebarExpanded } from "./sidebar-shell-helpers"

export const SidebarContent = (props: {
  mobile?: boolean
  opened: Accessor<boolean>
  aimMove: (event: MouseEvent) => void
  projects: Accessor<LocalProject[]>
  renderProject: (project: LocalProject) => JSX.Element
  handleDragStart: (event: unknown) => void
  handleDragEnd: () => void
  handleDragOver: (event: DragEvent) => void
  openProjectLabel: JSX.Element
  openProjectKeybind: Accessor<string | undefined>
  onOpenProject: () => void
  renderProjectOverlay: () => JSX.Element
  marketLabel: Accessor<string>
  onOpenMarket: () => void
  tasksLabel: Accessor<string>
  onOpenTasks: () => void
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
  onOpenSettings: () => void
  logoutLabel: Accessor<string>
  onLogout: () => void
  renderPanel: () => JSX.Element
}): JSX.Element => {
  const expanded = createMemo(() => sidebarExpanded(props.mobile, props.opened()))
  const placement = () => (props.mobile ? "bottom" : "right")
  const projectRailClass = () =>
    props.mobile
      ? "shrink-0 border-b border-border-weak-base bg-background-base"
      : "w-16 shrink-0 bg-background-base flex flex-col items-center overflow-hidden"
  const projectListClass = () =>
    props.mobile
      ? "w-full flex items-center gap-2 px-3 py-2 overflow-x-auto no-scrollbar"
      : "h-full w-full flex flex-col items-center gap-3 px-3 py-2 overflow-y-auto no-scrollbar"
  const utilityBarClass = () =>
    props.mobile
      ? "shrink-0 flex items-center gap-1 pl-2 ml-1 border-l border-border-weak-base"
      : "shrink-0 w-full pt-3 pb-3 flex flex-col items-center gap-2"

  return (
    <div classList={{ "flex h-full w-full overflow-hidden": true, "flex-col": !!props.mobile }}>
      <div class={projectRailClass()} onMouseMove={props.aimMove}>
        <div classList={{ "flex-1 min-h-0 w-full": true, "overflow-hidden": !props.mobile }}>
          <DragDropProvider
            onDragStart={props.handleDragStart}
            onDragEnd={props.handleDragEnd}
            onDragOver={props.handleDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragXAxis />
            <div class={projectListClass()}>
              <ScheduledTasksTile
                mobile={props.mobile}
                placement={placement}
                onClick={props.onOpenTasks}
                label={props.tasksLabel}
              />
              <SortableProvider ids={props.projects().map((p) => p.worktree)}>
                <For each={props.projects()}>{(project) => props.renderProject(project)}</For>
              </SortableProvider>
              <div class={utilityBarClass()}>
                <Tooltip
                  placement={placement()}
                  value={
                    <div class="flex items-center gap-2">
                      <span>{props.openProjectLabel}</span>
                      <Show when={!props.mobile && !!props.openProjectKeybind()}>
                        <span class="text-icon-base text-12-medium">{props.openProjectKeybind()}</span>
                      </Show>
                    </div>
                  }
                >
                  <IconButton
                    icon="plus"
                    variant="ghost"
                    size="large"
                    onClick={props.onOpenProject}
                    aria-label={typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined}
                  />
                </Tooltip>
                <Tooltip placement={placement()} value={props.marketLabel()}>
                  <IconButton
                    icon="app-market"
                    variant="ghost"
                    size="large"
                    onClick={props.onOpenMarket}
                    aria-label={props.marketLabel()}
                  />
                </Tooltip>
                <TooltipKeybind
                  placement={placement()}
                  title={props.settingsLabel()}
                  keybind={!props.mobile ? (props.settingsKeybind() ?? "") : ""}
                >
                  <IconButton
                    icon="settings-gear"
                    variant="ghost"
                    size="large"
                    onClick={props.onOpenSettings}
                    aria-label={props.settingsLabel()}
                  />
                </TooltipKeybind>
                <Tooltip placement={placement()} value={props.logoutLabel()}>
                  <IconButton
                    icon="enter"
                    variant="ghost"
                    size="large"
                    onClick={props.onLogout}
                    aria-label={props.logoutLabel()}
                  />
                </Tooltip>
              </div>
            </div>
            <DragOverlay>{props.renderProjectOverlay()}</DragOverlay>
          </DragDropProvider>
        </div>
      </div>

      <Show when={expanded()}>{props.renderPanel()}</Show>
    </div>
  )
}

function ScheduledTasksTile(props: {
  mobile?: boolean
  placement: () => "bottom" | "right"
  onClick: () => void
  label: Accessor<string>
}) {
  const location = useLocation()
  const isActive = createMemo(() => location.pathname.startsWith("/system/tasks"))

  return (
    <Tooltip placement={props.placement()} value={props.label()}>
      <button
        onClick={props.onClick}
        aria-label={props.label()}
        classList={{
          "flex items-center justify-center rounded-lg transition-colors cursor-pointer": true,
          "size-10": !props.mobile,
          "size-8": !!props.mobile,
          "bg-background-brand-dimmed text-icon-brand": isActive(),
          "text-icon-dimmed hover:text-icon-base hover:bg-background-hover": !isActive(),
        }}
      >
        <Icon name="checklist" size={props.mobile ? "small" : "medium"} />
      </button>
    </Tooltip>
  )
}
