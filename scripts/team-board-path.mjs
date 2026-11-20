import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { type } from 'arktype'

const boardOverride = type('string | undefined')

// The toolkit lives outside every project, so the board is found from the working directory: TEAM_TASKS_FILE,
// else tasks.json beside the repository's common git dir (worktrees share one board), else ./tasks.json.
export function resolveBoardFile() {
  const override = boardOverride.assert(process.env.TEAM_TASKS_FILE)
  if (override) return resolve(override)
  const cwd = process.cwd()
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (common) return join(dirname(common), 'tasks.json')
  } catch {
    // A directory outside git uses the working-directory board.
  }
  return join(cwd, 'tasks.json')
}
