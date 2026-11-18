import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))

// Relative specifiers a file imports: `from './x'`, bare `import './x'` and `import('./x')`.
function relativeImports(source: string): Set<string> {
  const found = new Set<string>()
  for (const m of source.matchAll(/(?:from\s+|import\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) found.add(m[1] as string)
  return found
}

function closure(entry: string): string[] {
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const abs = join(SCRIPTS, file)
    for (const spec of relativeImports(readFileSync(abs, 'utf8'))) {
      walk(relative(SCRIPTS, resolve(dirname(abs), spec)).split('\\').join('/'))
    }
  }
  walk(entry)
  return [...seen].sort((a, b) => a.localeCompare(b))
}

describe('the board CLI file set', () => {
  it('lists every module team-tasks.mjs can load, and each one exists', () => {
    const files = closure('team-tasks.mjs')
    expect(files).toEqual(
      [
        'board-git-proof.mjs',
        'evidence-scope.mjs',
        'review-queue.mjs',
        'jev-executors.catalog.mjs',
        'team-board-delivery.mjs',
        'team-board-path.mjs',
        'team-board-view.mjs',
        'team-catalog.mjs',
        'team-review.mjs',
        'team-tasks.lib.mjs',
        'team-tasks.mjs',
        'text-guard.mjs',
      ].sort((a, b) => a.localeCompare(b)),
    )
    for (const file of files) expect(existsSync(join(SCRIPTS, file)), file).toBe(true)
  })
})
