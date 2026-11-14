// What lives for the whole process: the parsed config, the write token and the one board watcher. It hangs off
// globalThis so a dev-server module reload keeps the same token and the same watch instead of stacking new ones.
import { config } from './board-config.server'
import type { Config } from './board-config.server'
import { newToken } from './access.server'
import { createBoardWatcher } from './board-watch.server'
import type { BoardWatcher } from './board-watch.server'

type AppState = { config: Config; token: string; watcher: BoardWatcher }

const KEY = Symbol.for('team-board.app-state')
type Holder = { [KEY]?: AppState }

export function appState(): AppState {
  const holder = globalThis as Holder
  holder[KEY] ??= (() => {
    const resolved = config()
    return { config: resolved, token: newToken(), watcher: createBoardWatcher(resolved.boardFile) }
  })()
  return holder[KEY]
}
