// The top line: what this is, whether its data is live, and which build is serving it.
import { Link } from '@tanstack/react-router'
import { GitCommitHorizontal, Radio, RefreshCw, Settings2, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { Session } from './board-contract'
import { POLL_MS } from './board-connection'
import type { Connection } from './board-state'
import { clockLabel } from './format'

const POLL_SECONDS = POLL_MS / 1000

function statusOf(connection: Connection, lastReadAt: number | null): { Icon: LucideIcon; text: string } {
  switch (connection) {
    case 'live':
      return { Icon: Radio, text: 'Live' }
    case 'connecting':
      return { Icon: RefreshCw, text: 'Connecting' }
    case 'polling':
      return { Icon: RefreshCw, text: `Reconnecting, checking every ${POLL_SECONDS} s` }
    case 'stale':
      return {
        Icon: TriangleAlert,
        text: lastReadAt === null ? 'Not reading the board' : `Stale, last read ${clockLabel(lastReadAt)}`,
      }
  }
}

export function Header({
  connection,
  lastReadAt,
  build,
}: {
  connection: Connection
  lastReadAt: number | null
  build: Session['build'] | null
}) {
  const { Icon, text } = statusOf(connection, lastReadAt)
  return (
    <header className='header'>
      <h1 className='title'>Team board</h1>
      <p className='status' data-state={connection} role='status'>
        <Icon aria-hidden='true' />
        <span>{text}</span>
      </p>
      <Link to='/settings' className='header-link'>
        <Settings2 aria-hidden='true' />
        <span>Lead thread</span>
      </Link>
      {build && (
        <p
          className='build'
          title={build.behind === 'behind' ? 'main has newer board code than this server runs' : undefined}
        >
          <GitCommitHorizontal aria-hidden='true' />
          <span>Build {build.sha.slice(0, 7)}</span>
          {build.behind === 'behind' && <span data-behind='behind'>behind main</span>}
        </p>
      )}
    </header>
  )
}
