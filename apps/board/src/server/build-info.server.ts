// Which build is running and whether `origin/main` has moved past it. The comparison is on the app's own tree
// (`apps/board`), so a merge that touches only other workspaces does not call this build behind. It reads the
// local `origin/main` ref and never fetches.
import { execFile } from 'node:child_process'
import type { BuildInfo } from '../board/board-contract'
import type { Config } from './board-config.server'

const GIT_TIMEOUT_MS = 5_000
const CACHE_MS = 60_000
export const APP_TREE = 'apps/board'

function treeOf(repo: string, ref: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}:${APP_TREE}`],
      { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    )
  })
}

/** current when the build's tree equals origin/main's, behind when they differ, unknown when git cannot say. */
export async function compareBuild(repo: string, sha: string): Promise<BuildInfo['behind']> {
  const [built, main] = await Promise.all([treeOf(repo, sha), treeOf(repo, 'origin/main')])
  if (built === null || main === null) return 'unknown'
  return built === main ? 'current' : 'behind'
}

let cached: { at: number; info: BuildInfo } | undefined

export async function buildInfo(config: Pick<Config, 'repo' | 'buildSha'>, now = Date.now()): Promise<BuildInfo> {
  if (cached && now - cached.at < CACHE_MS) return cached.info
  const sha = config.buildSha
  const info: BuildInfo =
    sha === null ? { sha: 'dev', behind: 'unknown' } : { sha, behind: await compareBuild(config.repo, sha) }
  cached = { at: now, info }
  return info
}
