// The one module that reads the process environment. Everything else gets the parsed Config.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import * as z from 'zod'
import { integerTextIn } from '../schema'

export const DEFAULT_PORT = 4788

const T3_HOME_BIN = join(homedir(), '.t3', 'bin', 't3')

const nonEmpty = z.string().min(1)

const Env = z.object({
  TEAM_BOARD_CLI: nonEmpty.exactOptional(),
  TEAM_BOARD_PROJECT: nonEmpty.exactOptional(),
  TEAM_TASKS_FILE: nonEmpty.exactOptional(),
  TEAM_BOARD_NODE: nonEmpty.exactOptional(),
  TEAM_BOARD_T3_BIN: nonEmpty.exactOptional(),
  TEAM_BOARD_BUILD_SHA: nonEmpty.exactOptional(),
  TEAM_BOARD_TAILNET_HOST: z.string().exactOptional(),
  TEAM_BOARD_TAILNET_LOGINS: z.string().exactOptional(),
  PORT: integerTextIn(1, 65535).exactOptional(),
})

export type TailnetConfig = { host: string; logins: string[] }

export type Config = {
  /** The toolkit's board CLI, the one the agents run. Defaults to $DEREK_SKILLS or ~/derek-skills. */
  cli: string
  /** The toolkit checkout that holds the CLI; `git` reads from here for the build comparison. */
  repo: string
  /** The project checkout the agents work in: it holds the board, and is the T3 project whose threads the board lists. Defaults to the working directory. */
  project: string
  /** The project's board file the CLI reads and the watcher watches. Defaults to tasks.json in the project. */
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

/** Parse the environment. A bad value throws, so the server refuses to start on it. */
export function readConfig(env: Record<string, string | undefined>): Config {
  const parsed = Env.safeParse(env)
  if (!parsed.success) throw new Error(`board app environment: ${z.prettifyError(parsed.error)}`)
  const envConfig = parsed.data
  const toolkit = env.DEREK_SKILLS || join(homedir(), 'derek-skills')
  const cli = envConfig.TEAM_BOARD_CLI ?? join(toolkit, 'scripts', 'team-tasks.mjs')
  const repo = dirname(dirname(cli))
  const project = resolve(
    envConfig.TEAM_BOARD_PROJECT ?? (envConfig.TEAM_TASKS_FILE ? dirname(envConfig.TEAM_TASKS_FILE) : process.cwd()),
  )
  return {
    cli,
    repo,
    project,
    boardFile: envConfig.TEAM_TASKS_FILE ?? join(project, 'tasks.json'),
    node: envConfig.TEAM_BOARD_NODE ?? 'node',
    t3: envConfig.TEAM_BOARD_T3_BIN ?? (existsSync(T3_HOME_BIN) ? T3_HOME_BIN : 't3'),
    port: envConfig.PORT ?? DEFAULT_PORT,
    buildSha: envConfig.TEAM_BOARD_BUILD_SHA ?? null,
    tailnet: tailnetFrom(envConfig.TEAM_BOARD_TAILNET_HOST, envConfig.TEAM_BOARD_TAILNET_LOGINS),
  }
}

let current: Config | undefined

/** The process's configuration, read once. */
export function config(): Config {
  current ??= readConfig(process.env)
  return current
}
