// Re-capture the `view` fixture the unit tests read: `bun tests/capture-fixture.ts`.
// It builds a scratch board with the real CLI and saves what `view` printed, so the fixture is the CLI's own
// output and the tests notice when the CLI's shape moves away from board-contract.ts.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OWNERS, cli, seedBoard } from './temp-board'

const dir = mkdtempSync(join(tmpdir(), 'board-fixture-'))
const seed = seedBoard(join(dir, 'tasks.json'), { closed: 3 })
// An owner note that cannot be delivered: the card gets an unread-note mark and an undelivered count.
cli(seed.file, ['note', String(seed.quiet), 'The watcher is done', '--by', OWNERS.backend])
const view = cli(seed.file, ['view', '--closed-limit', '2'])

const target = new URL('./fixtures/view.json', import.meta.url)
writeFileSync(target, `${JSON.stringify(JSON.parse(view), null, 2)}\n`)
console.log(`wrote ${target.pathname}`)
