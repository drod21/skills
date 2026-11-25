import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'
import * as z from 'zod'

const scopeSchema = z.strictObject({
  title: z.string(),
  accept: z.string(),
  candidate: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).exactOptional(),
  artifacts: z
    .array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
    .min(1)
    .max(12),
})

export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024

/** The bytes of a regular file of at most 25 MiB. A symlink, a special file or a larger file throws. */
export function readEvidenceFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES)
      throw new Error('evidence needs a regular file no larger than 25 MiB')
    const bytes = Buffer.allocUnsafe(stat.size + 1)
    let size = 0
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null)
      if (!read) break
      size += read
    }
    if (size !== stat.size) throw new Error('evidence changed while reading')
    return bytes.subarray(0, size)
  } finally {
    closeSync(fd)
  }
}

export function readScopedEvidence(path) {
  if (!isAbsolute(path)) throw new Error('scoped evidence needs an absolute retained path')
  return readEvidenceFile(path)
}

export function evidenceDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The directory name a retained copy lives under: the first 12 hex characters of its sha256. */
export function evidenceContentId(bytes) {
  return evidenceDigest(bytes).slice(0, 12)
}

/** The content id a board-retained path (`tasks.json.artifacts/<task>/<contentId>/<name>`) names, or null. */
export function retainedEvidenceContentId(path) {
  const contentDir = dirname(path)
  const taskDir = dirname(contentDir)
  if (basename(dirname(taskDir)) !== 'tasks.json.artifacts' || !/^\d+$/.test(basename(taskDir))) return null
  return basename(contentDir)
}

/** True when a retained path still holds the bytes its content id names. */
export function retainedEvidenceIntact(path) {
  const contentId = retainedEvidenceContentId(path)
  if (contentId === null) return false
  try {
    return evidenceContentId(readEvidenceFile(path)) === contentId
  } catch {
    return false
  }
}

export function normalizeEvidenceScope(scope) {
  const checked = scopeSchema.parse(scope)
  if (checked.artifacts.some(({ path }) => !isAbsolute(path)))
    throw new Error('scoped evidence needs absolute retained paths')
  return checked
}

export function assertEvidenceScope(task, scope) {
  if (!scope) return
  if (scope.title !== task.title || scope.accept !== task.accept || scope.candidate !== task.gitProof?.candidate)
    throw new Error(`task ${task.id} acceptance changed since the check; run the check again`)
  for (const { path, sha256 } of scope.artifacts) {
    let digest
    try {
      if (task.evidence.includes(path)) digest = evidenceDigest(readScopedEvidence(path))
    } catch {}
    if (digest !== sha256)
      throw new Error(`task ${task.id} selected evidence changed or is unavailable; run the check again`)
  }
}
