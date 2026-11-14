// Delivery, right after a write. The thread routes and the move route share this one module so they share its one
// run at a time: a thread message and a move that land together make one more sweep, not two overlapping ones.
import { spawnCli } from './board-cli.server'
import type { Config } from './board-config.server'

const DELIVER_TIMEOUT_MS = 90_000

type Flight = { again: boolean }
let flight: Flight | null = null
const settling = new Set<Promise<void>>()

/**
 * Ask the board to deliver now, so the owner sees "delivered" in seconds instead of at the next 15 s sweep. One run
 * at a time: a request that arrives during a run makes one more full sweep after it. Never awaited by a response.
 */
export function kickDelivery(config: Pick<Config, 'cli' | 'boardFile' | 'node'>, taskId: number | null): void {
  if (flight) {
    flight.again = true
    return
  }
  const mine: Flight = { again: false }
  flight = mine
  const run = (async () => {
    let scope = taskId
    try {
      for (;;) {
        mine.again = false
        const args = scope === null ? ['deliver'] : ['deliver', '--task', String(scope)]
        const spawned = await spawnCli(config, args, DELIVER_TIMEOUT_MS)
        if (spawned.failure) process.stderr.write(`board delivery: ${spawned.failure.message}\n`)
        if (!mine.again) break
        scope = null
      }
    } finally {
      flight = null
    }
  })()
  settling.add(run)
  void run.finally(() => settling.delete(run))
}

/** Resolves when no delivery run is in flight. For tests. */
export const deliveryIdle = async (): Promise<void> => {
  await Promise.allSettled([...settling])
}
