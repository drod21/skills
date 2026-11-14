import { createHash } from 'node:crypto'
import { extname } from 'node:path'

const mediaTypes = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}
export const reviewMediaType = (path) => mediaTypes[extname(path).toLowerCase()] ?? null

// Shared by the locked board writer and its read-only dashboard projection.
export function reviewRevision(task) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: task.id,
        title: task.title,
        status: task.status,
        owner: task.owner,
        evidence: task.evidence,
        decisions: task.decisions,
      }),
    )
    .digest('hex')
}

const priority = { urgent: 0, blocked: 1, review: 2, idea: 3 }

// Only explicit human questions enter this queue. Jev holds remain on the team board.
export function reviewQueue(tasks, questions) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return questions
    .map((summary) => {
      const task = byId.get(summary.id)
      const ask = task.decisions.findLast((entry) => entry.kind === 'owner-ask')
      return {
        ...summary,
        revision: reviewRevision(task),
        packet: ask.packet ?? null,
        evidence: task.evidence ?? [],
        unblocks: tasks.filter((other) => other.status === 'open' && other.after?.includes(task.id)).length,
      }
    })
    .sort(
      (a, b) =>
        priority[a.packet?.priority ?? 'blocked'] - priority[b.packet?.priority ?? 'blocked'] ||
        b.unblocks - a.unblocks ||
        Date.parse(a.thread.ask.at) - Date.parse(b.thread.ask.at) ||
        a.id - b.id,
    )
}
