import { TaskSidebar } from "./task-sidebar"
import { TaskDetail } from "./task-detail"

export default function TaskListPage() {
  return (
    <div class="size-full flex overflow-hidden">
      {/* Left sidebar: task list */}
      <div class="w-64 shrink-0 border-r border-border-base">
        <TaskSidebar />
      </div>

      {/* Main content: task detail (three zones + tool panel) */}
      <div class="flex-1 min-w-0">
        <TaskDetail />
      </div>
    </div>
  )
}
