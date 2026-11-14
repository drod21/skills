// The small facts under a task's number: its status, role and tag, as plain text.
import type { Thread } from './thread-contract'

export function TaskStatusLine({ task }: { task: Thread['task'] }) {
  return (
    <>
      <span>{task.status}</span>
      {task.role && <span>{task.role}</span>}
      {task.tag && <span>{task.tag}</span>}
      {task.archived && <span>archived</span>}
    </>
  )
}
