// Small display rules shared by the cards and the header. Each takes the clock as an argument so the first
// render on the server and in the browser agree and a test can fix the time.

/** "now", "5m", "3h", "2d", "3w": how long ago, in the fewest characters that stay exact enough to triage by. */
export function ageLabel(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return null
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  return days < 14 ? `${days}d` : `${Math.round(days / 7)}w`
}

/** Whole hours since a time, or null when there is none. */
export function hoursSince(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null
  const then = Date.parse(iso)
  return Number.isFinite(then) ? Math.max(0, Math.floor((nowMs - then) / 3_600_000)) : null
}

/**
 * A claim owner as a person can read it. Owners are free text: a worker's chosen name, a path
 * (`/root/study_v3_runtime_qa`), or a delegated task id with its provider prefix percent-encoded.
 */
export function ownerLabel(owner: string): string {
  let text = owner
  try {
    text = decodeURIComponent(owner)
  } catch {
    // A stray percent sign: keep the text as it came.
  }
  if (text.startsWith('node:delegated-task:')) return text.slice(text.lastIndexOf(':') + 1) || text
  const lastSlash = text.lastIndexOf('/')
  return lastSlash >= 0 && lastSlash < text.length - 1 ? text.slice(lastSlash + 1) : text
}

/** "How long ago the last update came", for the header: seconds, then minutes. */
export function sinceLabel(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 90) return `${seconds} s ago`
  return `${Math.round(seconds / 60)} min ago`
}

export const clockLabel = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
