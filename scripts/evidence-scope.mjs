import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { type } from 'arktype'

const scopeSchema = type({
  '+': 'reject',
  title: 'string',
  accept: 'string',
  'candidate?': /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/,
  artifacts: type({ path: 'string', sha256: /^[a-f0-9]{64}$/ }).array().atLeastLength(1).atMostLength(12),
})

export function readScopedEvidence(path) {
  if (!isAbsolute(path)) throw new Error('scoped evidence needs an absolute retained path')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024)
      throw new Error('scoped evidence needs a retained file no larger than 25 MiB')
    const bytes = Buffer.allocUnsafe(stat.size + 1)
    let size = 0
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null)
      if (!read) break
      size += read
    }
    if (size !== stat.size) throw new Error('scoped evidence changed while reading')
    return bytes.subarray(0, size)
  } finally {
    closeSync(fd)
  }
}

export function evidenceDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function normalizeEvidenceScope(scope) {
  const checked = scopeSchema.assert(scope)
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
