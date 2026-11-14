// The one module that reads the process environment. Everything else gets the parsed Config.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type } from 'arktype'

export const DEFAULT_PORT = 4788

const T3_HOME_BIN = join(homedir(), '.t3', 'bin', 't3')

const nonEmpty = type('string > 0')

const Env = type({
  'TEAM_BOARD_CLI?': nonEmpty,
  'TEAM_TASKS_FILE?': nonEmpty,
  'TEAM_BOARD_NODE?': nonEmpty,
  'TEAM_BOARD_T3_BIN?': nonEmpty,
  'TEAM_BOARD_BUILD_SHA?': nonEmpty,
  'TEAM_BOARD_TAILNET_HOST?': 'string',
  'TEAM_BOARD_TAILNET_LOGINS?': 'string',
  'PORT?': type('string.integer.parse').to('1 <= number.integer <= 65535'),
})

export type TailnetConfig = { host: string; logins: string[] }

export type Config = {
  /** The toolkit's board CLI, the one the agents run. Defaults to $DEREK_SKILLS or ~/derek-skills. */
  cli: string
  /** The toolkit checkout that holds the CLI; `git` reads from here for the build comparison. */
  repo: string
  /** The project's board file the CLI reads and the watcher watches. Defaults to ./tasks.json. */
  boardFile: string
  /** The Node binary that runs the CLI. */
  node: string
  /** The `t3` binary that lists threads. The board CLI reads the same variable to send to them. */
  t3: string
  /** Where this process listens, always on loopback. */
  port: number
  buildSha: string | null
  /** Tailnet serving, off (null) unless both the host and a login are set. */
  tailnet: TailnetConfig | null
}

/** The tailnet name and the logins allowed through it; null (tailnet off) unless both are set. */
export function tailnetFrom(host: string | undefined, logins: string | undefined): TailnetConfig | null {
  const name = (host ?? '').trim().toLowerCase().replace(/\.$/, '')
  const allowed = (logins ?? '')
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean)
  return name && allowed.length ? { host: name, logins: allowed } : null
}

/** Parse the environment. A bad value throws with arktype's summary, so the server refuses to start on it. */
export function readConfig(env: Record<string, string | undefined>): Config {
  const parsed = Env(env)
  if (parsed instanceof type.errors) throw new Error(`board app environment: ${parsed.summary}`)
  const toolkit = env.DEREK_SKILLS || join(homedir(), 'derek-skills')
  const cli = parsed.TEAM_BOARD_CLI ?? join(toolkit, 'scripts', 'team-tasks.mjs')
  const repo = dirname(dirname(cli))
  return {
    cli,
    repo,
    boardFile: parsed.TEAM_TASKS_FILE ?? join(process.cwd(), 'tasks.json'),
    node: parsed.TEAM_BOARD_NODE ?? 'node',
    t3: parsed.TEAM_BOARD_T3_BIN ?? (existsSync(T3_HOME_BIN) ? T3_HOME_BIN : 't3'),
    port: parsed.PORT ?? DEFAULT_PORT,
    buildSha: parsed.TEAM_BOARD_BUILD_SHA ?? null,
    tailnet: tailnetFrom(parsed.TEAM_BOARD_TAILNET_HOST, parsed.TEAM_BOARD_TAILNET_LOGINS),
  }
}

let current: Config | undefined

/** The process's configuration, read once. */
export function config(): Config {
  current ??= readConfig(process.env)
  return current
}
