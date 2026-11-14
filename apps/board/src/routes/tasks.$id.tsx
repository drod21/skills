// The place a card opens: the task's thread, where the owner reads what was said and sends a note or an answer.
import { createFileRoute, notFound } from '@tanstack/react-router'
import { type } from 'arktype'
import { TaskThread } from '../thread/TaskThread'

const TaskParams = type({ id: 'string.integer.parse' }).to({ id: 'number.integer > 0' })

export const Route = createFileRoute('/tasks/$id')({
  params: {
    parse: (raw) => {
      const parsed = TaskParams(raw)
      if (parsed instanceof type.errors) throw notFound()
      return parsed
    },
    stringify: ({ id }) => ({ id: String(id) }),
  },
  head: ({ params }) => ({ meta: [{ title: `Task #${params.id} | Team board` }] }),
  component: TaskPage,
})

function TaskPage() {
  const { id } = Route.useParams()
  return <TaskThread id={id} />
}
