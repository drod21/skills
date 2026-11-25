// The place a card opens: the task's thread, where the owner reads what was said and sends a note or an answer.
import { createFileRoute, notFound } from '@tanstack/react-router'
import * as z from 'zod'
import { positiveIntegerText } from '../schema'
import { TaskThread } from '../thread/TaskThread'

const TaskParams = z.object({ id: positiveIntegerText })

export const Route = createFileRoute('/tasks/$id')({
  params: {
    parse: (raw) => {
      const parsed = TaskParams.safeParse(raw)
      if (!parsed.success) throw notFound()
      return parsed.data
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
