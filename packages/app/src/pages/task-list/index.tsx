import { TaskDetail } from "./task-detail"

export default function TaskListPage() {
  return (
    <div class="size-full flex overflow-hidden">
      <div class="flex-1 min-w-0">
        <TaskDetail />
      </div>
    </div>
  )
}
