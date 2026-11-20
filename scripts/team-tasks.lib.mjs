// Board logic for scripts/team-tasks.mjs, kept free of argv so it can be tested.
//
// Self-healing rule: heal only what is provably broken (a dead lock, an orphaned temp
// file, a corrupt board with a good backup, a claim with no owner, leftover claim
// fields on an open or cancelled task, a stale run on a claimed task, duplicate
// string evidence) and say so on stderr. A done task keeps claimedAt, heartbeatAt,
// and run as provenance. Anything ambiguous, above all whether a claimed task's
// worker is still alive, is reported and left for the lead.
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { type } from 'arktype'
import {
  assertEvidenceScope,
  evidenceContentId,
  normalizeEvidenceScope,
  readEvidenceFile,
  retainedEvidenceContentId,
  retainedEvidenceIntact,
} from './evidence-scope.mjs'
import { normalizeGitProof, verifyGitProof } from './board-git-proof.mjs'

import { enqueueDeliveries, settleClaimOnlyDeliveries } from './team-board-delivery.mjs'
import { matchStoredExecutor } from './jev-executors.catalog.mjs'
import { JEV_CHECKS, JEV_HOLDS, JEV_ROUTES, KNOWN_ROUTES, ROLES, unknownRoleMessage } from './team-catalog.mjs'
import { cleanText, secretFileReason } from './text-guard.mjs'
import { reviewRevision, reviewMediaType } from './review-queue.mjs'

export { JEV_CHECKS, JEV_HOLDS, JEV_ROUTES, KNOWN_ROUTES }

export const STATUSES = ['open', 'claimed', 'done', 'cancelled']
export const RUN_KINDS = ['workflow', 't3_task', 'subagent', 'session']
// The dashboard signs a local write as this name, and `moves` defaults `--by` to it.
// Any other `by` is that person's name.
export const BOARD_OWNER = 'owner'
const CLAIM_RESIDUE = ['run', 'wake', 'claimedAt', 'heartbeatAt']
const STALE_LOCK_MS = 30_000
const ORPHAN_TMP_MS = 10 * 60_000
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// What this process repaired, so the CLI can print it. A repair nobody sees is a hidden mutation.
const healEvents = []
export function drainHealEvents() {
  return healEvents.splice(0)
}

// ---------------------------------------------------------------- lock

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function readLockOwner(lock) {
  try {
    return JSON.parse(readFileSync(join(lock, 'owner'), 'utf8'))
  } catch {
    return null
  }
}

/** A lock is stale when its owner process is gone, or (legacy locks, no owner file) when it is old. */
export function lockState(lock, now = Date.now()) {
  let mtime
  try {
    mtime = statSync(lock).mtimeMs
  } catch {
    return { held: false }
  }
  const owner = readLockOwner(lock)
  const ageMs = now - mtime
  if (owner && !pidAlive(owner.pid)) return { held: true, stale: true, reason: `owner pid ${owner.pid} is gone`, owner }
  if (ageMs > STALE_LOCK_MS) return { held: true, stale: true, reason: `held for ${Math.round(ageMs / 1000)}s`, owner }
  return { held: true, stale: false, owner }
}

// rename is atomic, so exactly one racer removes a stale lock. If what we removed was not the
// lock we judged stale (someone broke it and took a fresh one first), put it back.
function breakLock(lock, observed) {
  const grave = `${lock}.stale.${process.pid}.${randomBytes(3).toString('hex')}`
  try {
    renameSync(lock, grave)
  } catch {
    return false
  }
  const removed = readLockOwner(grave)
  if (observed?.token && removed?.token && removed.token !== observed.token) {
    try {
      renameSync(grave, lock)
      return false
    } catch {}
  }
  rmSync(grave, { recursive: true, force: true })
  return true
}

function acquire(lock) {
  const token = randomBytes(8).toString('hex')
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      mkdirSync(lock)
      try {
        writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }))
      } catch (error) {
        rmSync(lock, { recursive: true, force: true })
        throw error
      }
      return token
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const state = lockState(lock)
      if (state.stale && breakLock(lock, state.owner)) {
        healEvents.push(`broke a stale board lock (${state.reason})`)
      } else {
        sleep(25 + Math.random() * 50)
      }
    }
  }
  const owner = readLockOwner(lock)
  throw new Error(`could not acquire the board lock${owner ? ` (held by pid ${owner.pid} since ${owner.at})` : ''}`)
}

function release(lock, token) {
  // If our lock was broken as stale, the lock now belongs to someone else: leave it.
  if (readLockOwner(lock)?.token !== token) return
  rmSync(lock, { recursive: true, force: true })
}

// ---------------------------------------------------------------- file

function parseBoard(text) {
  const board = JSON.parse(text)
  if (!board || typeof board !== 'object' || !Array.isArray(board.tasks)) throw new Error('no tasks array')
  return board
}

function writeAtomic(file, board) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`)
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * Reads the board. A missing file is an empty board. An unreadable file is restored from the backup
 * of the last board this script wrote, only when `repair` is set (under the lock); the broken file is kept beside it, never
 * deleted. With no usable backup this throws and changes nothing: an empty board is never invented.
 */
export function readBoardFile(file, { repair = false } = {}) {
  if (!existsSync(file)) return { board: { version: 1, tasks: [] } }
  try {
    return { board: parseBoard(readFileSync(file, 'utf8')) }
  } catch (error) {
    const backup = `${file}.bak`
    let restored = null
    if (existsSync(backup)) {
      try {
        restored = parseBoard(readFileSync(backup, 'utf8'))
      } catch {}
    }
    if (!restored) {
      throw new Error(
        `${file} is unreadable (${error.message}) and there is no usable ${basename(backup)}. Nothing was changed; restore it by hand.`,
      )
    }
    if (!repair) {
      throw new Error(
        `${file} is unreadable (${error.message}); a good backup exists. Run \`team-tasks.mjs doctor --fix\` to restore it.`,
      )
    }
    const quarantined = `${file}.corrupt-${Date.now()}`
    renameSync(file, quarantined)
    writeAtomic(file, restored)
    healEvents.push(
      `${basename(file)} was unreadable (${error.message}); restored the last board this script wrote and kept the broken file as ${basename(quarantined)}. Edits made outside the script since then are only in that file.`,
    )
    return { board: restored }
  }
}

/** Removes temp files left by crashed writers. A live writer's temp file is never touched. */
export function orphanTmpFiles(file, now = Date.now()) {
  const dir = dirname(file)
  const name = basename(file)
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.tmp$`)
  const orphans = []
  for (const entry of readdirSync(dir)) {
    const match = pattern.exec(entry)
    if (!match) continue
    const path = join(dir, entry)
    let age = 0
    try {
      age = now - statSync(path).mtimeMs
    } catch {
      continue
    }
    if (!pidAlive(Number(match[1])) || age > ORPHAN_TMP_MS) orphans.push(path)
  }
  return orphans
}

function sweepTmp(file) {
  for (const path of orphanTmpFiles(file)) {
    rmSync(path, { force: true })
    healEvents.push(`removed orphaned temp file ${basename(path)}`)
  }
}

/** Problems that make a board unsafe to write. Anything legacy already present is tolerated. */
export function structuralProblems(board) {
  const problems = []
  const seen = new Set()
  for (const task of board.tasks) {
    if (!Number.isInteger(task.id) || task.id < 1) problems.push(`task has invalid id ${JSON.stringify(task.id)}`)
    else if (seen.has(task.id)) problems.push(`duplicate task id ${task.id}`)
    else seen.add(task.id)
    if (!STATUSES.includes(task.status))
      problems.push(`task ${task.id} has invalid status ${JSON.stringify(task.status)}`)
  }
  return problems
}

/** Runs `fn` on the board under the lock and writes it back atomically, after saving the previous copy. */
export function withBoard(file, fn) {
  const lock = `${file}.lock`
  const token = acquire(lock)
  try {
    sweepTmp(file)
    const { board } = readBoardFile(file, { repair: true })
    const before = new Set(structuralProblems(board))
    const snapshot = JSON.stringify(board)
    // Content heals are reported only when this write lands. A thrown command changes nothing.
    const mark = healEvents.length
    let wrote = false
    try {
      healBoard(board)
      const result = fn(board)
      healBoard(board)
      const introduced = structuralProblems(board).filter((problem) => !before.has(problem))
      if (introduced.length) throw new Error(`refusing to write the board: ${introduced.join('; ')}`)
      if (JSON.stringify(board) !== snapshot) {
        writeAtomic(file, board)
        wrote = true
        // The backup always matches the last board this script wrote, so restoring it loses only
        // edits made to the file by something else.
        copyFileSync(file, `${file}.bak`)
      }
      if (!wrote) healEvents.splice(mark)
      return result
    } catch (error) {
      if (!wrote) healEvents.splice(mark)
      throw error
    }
  } finally {
    release(lock, token)
  }
}

/** Read without the lock: rename makes a write atomic, so a reader sees a whole board. Never writes. */
export function readBoard(file) {
  return readBoardFile(file, { repair: false }).board
}

// ---------------------------------------------------------------- tasks

const findTask = (board, id) => {
  const task = board.tasks.find((candidate) => candidate.id === id)
  if (!task) throw new Error(`task ${id} does not exist`)
  return task
}

/** Mutations refuse a stub. Dependency checks still see its id and status. */
function findLiveTask(board, id) {
  const task = findTask(board, id)
  if (task.archived === true) throw new Error(`task ${id} is archived`)
  return task
}

const DAY_MS = 86_400_000
const BOARD_SIZE_BYTES = 300 * 1024
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

export function archivePath(boardFile) {
  return `${boardFile}.archive.jsonl`
}

function assertArchiveDays(days) {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0)
    throw new Error('archive needs --older-than-days <n> above zero')
}

/**
 * Why a task cannot be archived now, in the words the archive commands refuse with, or null when it can. The age
 * threshold is not part of it: `archive --older-than-days` adds that, `archive --id` and `moves` do not.
 */
export function archiveRefusal(task) {
  const id = task.id
  if (task.archived === true) return `task ${id} is already archived`
  if (task.status !== 'done' && task.status !== 'cancelled')
    return `task ${id} is ${task.status}; only a done or cancelled task can be archived`
  // A gated task that was forced done unconfirmed stays on the board, where doctor still reports it.
  if (task.status === 'done' && doneBlockers(task).length)
    return `task ${id} was marked done without passing its checks; it stays on the board for doctor`
  // A cancelled task can still owe the owner a reply; archiving it would drop the note from the inbox.
  if (ownerThread(task).note !== 'NoNote')
    return `task ${id} has an owner note the lead has not answered; it stays until the lead replies`
  if (task.deliveries?.some((record) => ['pending', 'sending', 'unaddressed'].includes(record.state)))
    return `task ${id} has a message not yet delivered; archive it once the message is sent or has failed`
  return null
}

function archiveCandidate(task, days, now) {
  if (archiveRefusal(task)) return false
  if (typeof task.doneAt !== 'string') return true
  const at = Date.parse(task.doneAt)
  if (!Number.isFinite(at)) return true
  return now.getTime() - at > days * DAY_MS
}

function stubTask(task) {
  return { id: task.id, status: task.status, archived: true }
}

function parseArchiveLine(line, archiveFile) {
  let task
  try {
    task = JSON.parse(line)
  } catch {
    return null
  }
  if (!Number.isInteger(task?.id)) throw new Error(`archive line has no task id in ${basename(archiveFile)}`)
  return task
}

/**
 * Every archive line in order. A last line with no newline that does not parse is a torn append (a crash mid-write)
 * and is skipped; `tornBytes` is its length so the next archive run can cut it. Any other bad line throws.
 */
function readArchiveLines(archiveFile) {
  if (!existsSync(archiveFile)) return { tasks: [], tornBytes: 0, unterminated: false }
  const bytes = readFileSync(archiveFile)
  const lines = bytes.toString('utf8').split('\n')
  const tasks = []
  let tornBytes = 0
  lines.forEach((line, index) => {
    if (!line) return
    const task = parseArchiveLine(line, archiveFile)
    // Counted on the raw bytes: a torn multibyte character does not decode back to its own length.
    if (task) tasks.push(task)
    else if (index === lines.length - 1) tornBytes = bytes.length - (bytes.lastIndexOf(0x0a) + 1)
    else throw new Error(`unreadable archive line ${index + 1} in ${basename(archiveFile)}`)
  })
  const unterminated = !tornBytes && bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a
  return { tasks, tornBytes, unterminated }
}

/** The last line for an id wins: a task archived again after it changed replaces the older copy. */
export function readArchiveMap(archiveFile) {
  const map = new Map()
  for (const task of readArchiveLines(archiveFile).tasks) map.set(task.id, task)
  return map
}

/** Bytes of a torn last line in the archive, or 0. Read-only. */
export function tornArchiveBytes(archiveFile) {
  return readArchiveLines(archiveFile).tornBytes
}

// Called under the board lock. A torn last line is cut before anything is appended after it.
function appendArchiveLines(archiveFile, tasks, { tornBytes, unterminated }) {
  // Reported by the archive command: withBoard drops heal events when the board itself does not change.
  if (tornBytes) truncateSync(archiveFile, statSync(archiveFile).size - tornBytes)
  if (!tasks.length) return
  const body = tasks.map((task) => JSON.stringify(task)).join('\n')
  appendFileSync(archiveFile, `${unterminated ? '\n' : ''}${body}\n`)
}

/**
 * Appends finished tasks to the archive, then replaces them with stubs. A task whose latest archive line is
 * identical is not appended again, but it is still stubbed; a changed task is appended and its line wins.
 * Returns how many tasks were stubbed and how many bytes of a torn last line were cut.
 */
export function archiveTasks(board, archiveFile, { days, now = new Date() } = {}) {
  assertArchiveDays(days)
  const read = readArchiveLines(archiveFile)
  const latest = new Map(read.tasks.map((task) => [task.id, JSON.stringify(task)]))
  const candidates = board.tasks.filter((task) => archiveCandidate(task, days, now))
  appendArchiveLines(
    archiveFile,
    candidates.filter((task) => latest.get(task.id) !== JSON.stringify(task)),
    read,
  )
  const moving = new Set(candidates.map((task) => task.id))
  if (moving.size) board.tasks = board.tasks.map((task) => (moving.has(task.id) ? stubTask(task) : task))
  return { archived: moving.size, tornBytesCut: read.tornBytes }
}

/** Archives one finished task now, under the same rules as the sweep minus its age threshold. */
export function archiveOne(board, archiveFile, id) {
  const task = findTask(board, id)
  const refusal = archiveRefusal(task)
  if (refusal) throw new Error(refusal)
  const read = readArchiveLines(archiveFile)
  const latest = read.tasks.findLast((line) => line.id === id)
  const unchanged = latest !== undefined && JSON.stringify(latest) === JSON.stringify(task)
  appendArchiveLines(archiveFile, unchanged ? [] : [task], read)
  board.tasks = board.tasks.map((candidate) => (candidate.id === id ? stubTask(candidate) : candidate))
  return { archived: 1, tornBytesCut: read.tornBytes }
}

export function mergedTask(task, archivedById) {
  if (task.archived !== true || !archivedById) return task
  const stored = archivedById.get(task.id)
  if (!stored) return task
  return { ...stored, ...task }
}

function isActiveTask(task) {
  return task.status === 'open' || task.status === 'claimed'
}

function taskMatches(task, { status, role, tag }) {
  if (status && task.status !== status) return false
  if (role && task.role !== role) return false
  if (tag && task.tag !== tag) return false
  return true
}

/** Default list is open and claimed. `--all` or `--status` uses the whole board, with stubs expanded. */
export function listBoard(file, { all = false, status = null, role = null, tag = null } = {}) {
  const board = readBoard(file)
  const full = all || status != null
  const archived = full ? readArchiveMap(archivePath(file)) : null
  const tasks = full ? board.tasks.map((task) => mergedTask(task, archived)) : board.tasks.filter(isActiveTask)
  return tasks.filter((task) => taskMatches(task, { status, role, tag }))
}

function tempRoots() {
  const found = []
  const add = (root) => {
    if (typeof root !== 'string' || !root) return
    if (!found.includes(root)) found.push(root)
    try {
      const real = realpathSync(root)
      if (!found.includes(real)) found.push(real)
    } catch {}
  }
  add(tmpdir())
  add('/tmp')
  add('/private/tmp')
  add('/var/folders')
  return found
}

function pathUnder(path, root) {
  if (process.platform === 'win32') {
    path = path.replaceAll('\\', '/').toLowerCase()
    root = root.replaceAll('\\', '/').toLowerCase()
  }
  if (path === root) return true
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix)
}

/** A stored string that already points under a temp root. Missing files still count. */
export function isVolatilePath(item) {
  if (typeof item !== 'string' || !item) return false
  return tempRoots().some((root) => pathUnder(item, root))
}

// A gated task snapshots every local file it is given, so its verdict stays bound to the attached bytes. An
// ungated task copies only temp files. A credentials filename is never read or copied.
function artifactAction(item, snapshotLocalFiles) {
  if (secretFileReason(basename(item))) return { kind: 'keep' }
  let stat
  try {
    stat = lstatSync(item)
  } catch {
    return { kind: 'keep' }
  }
  if (stat.isSymbolicLink()) return snapshotLocalFiles ? { kind: 'symlink' } : { kind: 'keep' }
  if (!stat.isFile()) return { kind: 'keep' }
  let real
  try {
    real = realpathSync(item)
  } catch {
    return { kind: 'keep' }
  }
  if (secretFileReason(basename(real))) return { kind: 'keep' }
  if (!snapshotLocalFiles && !tempRoots().some((root) => pathUnder(real, root))) return { kind: 'keep' }
  if (stat.size > MAX_ARTIFACT_BYTES) return { kind: 'oversize' }
  return { kind: 'copy', real }
}

// `<id>/<sha12>/<name>`: the copy keeps its original basename, so name checks (jev-ask refuses `.env`) still apply.
function artifactDir(boardFile, taskId, bytes) {
  return join(dirname(boardFile), 'tasks.json.artifacts', String(taskId), evidenceContentId(bytes))
}

function artifactName(item) {
  const base = basename(item)
  return base && base !== '.' && base !== '..' ? base : 'file'
}

function retainedBytesMatch(path, bytes) {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && stat.size === bytes.length && readFileSync(path).equals(bytes)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function copyArtifact(boardFile, taskId, item, real) {
  let bytes
  try {
    bytes = readEvidenceFile(real)
  } catch {
    throw new Error(`local evidence cannot be retained: ${basename(item)} (not a regular file of at most 25 MB)`)
  }
  const dir = artifactDir(boardFile, taskId, bytes)
  const dest = join(dir, artifactName(item))
  if (retainedBytesMatch(dest, bytes)) return dest
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, bytes, { mode: 0o400 })
    renameSync(tmp, dest)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  return dest
}

function storeOne(boardFile, taskId, item, notes, snapshotLocalFiles) {
  const action = artifactAction(item, snapshotLocalFiles)
  if (snapshotLocalFiles && (action.kind === 'symlink' || action.kind === 'oversize'))
    throw new Error(`local evidence cannot be retained: ${basename(item)} (${action.kind})`)
  if (action.kind === 'oversize') {
    notes.push(`evidence file is over 25 MB; stored the original path: ${item}`)
    return item
  }
  if (action.kind !== 'copy') return item
  return copyArtifact(boardFile, taskId, item, action.real)
}

/**
 * Copies temp files, and every local file for a gated task, beside the board before the caller takes the lock.
 * A missing id or a stub throws first, so a typo creates no directory. `rehearse` runs the caller's mutation on
 * a copy of the unlocked board with the original paths; a mutation the board would refuse copies nothing.
 * The locked write checks again.
 */
export function retainEvidence(boardFile, taskId, items, rehearse = null) {
  const board = readBoard(boardFile)
  const task = findLiveTask(board, taskId)
  if (rehearse) rehearse(structuredClone(board))
  const notes = []
  const stored = items.map((item) => storeOne(boardFile, taskId, item, notes, Boolean(task.accept)))
  return { stored, notes }
}

// A check, an accept or a done on a gated task needs every retained copy to still hold its bytes, and every
// existing local file to be retained: a legacy path could have changed since it was judged.
function assertRetainedEvidence(task) {
  for (const path of evidenceItems(task)) {
    if (retainedEvidenceContentId(path) !== null) {
      if (!retainedEvidenceIntact(path))
        throw new Error(
          `task ${task.id} retained evidence checksum could not be verified: ${basename(path)}; reattach the original file`,
        )
    } else if (isExistingFileEvidence(path)) {
      throw new Error(`task ${task.id} local evidence must be retained: ${basename(path)}; reattach the original file`)
    }
  }
}

function isExistingFileEvidence(path) {
  if (secretFileReason(basename(path))) return false
  try {
    const stat = lstatSync(path)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

function legacyEvidenceMatches(path, contentId) {
  try {
    const real = realpathSync(path)
    if (secretFileReason(basename(real))) return false
    return evidenceContentId(readEvidenceFile(real)) === contentId
  } catch {
    return false
  }
}

/** Full task. A stub is merged with its archive line; stub fields win. */
export function showTask(file, id) {
  const task = readBoard(file).tasks.find((candidate) => candidate.id === id)
  if (!task) throw new Error(`task ${id} does not exist`)
  if (task.archived !== true) return task
  return mergedTask(task, readArchiveMap(archivePath(file)))
}

const doneIds = (board) => new Set(board.tasks.filter((task) => task.status === 'done').map((task) => task.id))

function whyNotClaimable(board, task, role, { allowLeadWorkflow = false } = {}) {
  if (task.status !== 'open') return `it is ${task.status}${task.owner ? ` (owner ${task.owner})` : ''}`
  if (task.role !== role) return `it belongs to role ${task.role}, not ${role}`
  if (task.route === 'needs_lead') return 'it is held for the lead (route needs_lead)'
  if (task.route === 'lead_workflow' && !allowLeadWorkflow) return 'it is executed by the lead; claim it with --id'
  const done = doneIds(board)
  const waiting = (task.after ?? []).filter((id) => !done.has(id))
  if (waiting.length) return `it is waiting on task ${waiting.join(', ')}`
  return null
}

export function assertKnownRoute(route) {
  if (KNOWN_ROUTES.includes(route)) return
  throw new Error(`unknown route ${JSON.stringify(route)}; known routes: ${KNOWN_ROUTES.join(', ')}`)
}

/** `<kind>:<ref>`. The ref may itself contain colons. */
export function parseRun(value) {
  if (typeof value !== 'string') throw new Error(`--run must be <kind>:<ref>, got ${JSON.stringify(value)}`)
  const colon = value.indexOf(':')
  if (colon <= 0) throw new Error(`--run must be <kind>:<ref>, got ${JSON.stringify(value)}`)
  const kind = value.slice(0, colon)
  const ref = value.slice(colon + 1)
  if (!RUN_KINDS.includes(kind))
    throw new Error(`unknown run kind ${JSON.stringify(kind)}; known kinds: ${RUN_KINDS.join(', ')}`)
  if (!ref) throw new Error('--run ref must not be empty')
  return { kind, ref }
}

function jevError(message) {
  throw new Error(`jev verdict: ${message}`)
}

function parseVerdict(raw) {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    jevError('not valid JSON')
  }
}

function assertConfidence(confidence) {
  const ok = typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
  if (!ok) jevError('confidence must be a number from 0 to 1')
}

function assertHolds(holds) {
  const ok = Array.isArray(holds) && holds.every((hold) => JEV_HOLDS.includes(hold))
  if (!ok) jevError('holds must be an array of "risky" and "needs_decision"')
}

function assertSuggestedRole(suggestedRole) {
  const ok = suggestedRole === null || (typeof suggestedRole === 'string' && suggestedRole.length > 0)
  if (!ok) jevError('suggestedRole must be a non-empty string or null')
}

function assertCheck(check) {
  if (check === null || JEV_CHECKS.includes(check)) return
  jevError(`check must be null or one of ${JEV_CHECKS.join(', ')}`)
}

function assertReasons(reasons) {
  const ok = Array.isArray(reasons) && reasons.every((reason) => typeof reason === 'string')
  if (!ok) jevError('reasons must be an array of strings')
}

// Raw Jev answers ride along so thresholds can be retuned without another call. One verdict's answers
// are about 1 KB; the cap keeps a malformed payload from bloating the shared board.
const MAX_ANSWERS_CHARS = 16_000

function assertAnswers(answers) {
  if (answers === undefined) return
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) jevError('answers must be an object')
  if (JSON.stringify(answers).length > MAX_ANSWERS_CHARS)
    jevError(`answers must be under ${MAX_ANSWERS_CHARS} characters of JSON`)
}

// The executor a route resolved to. Optional: verdicts stored before the field existed omit it, and null
// means none was available or the route was held. A present executor must match the registry exactly
// (scripts/jev-executors.catalog.mjs). A needs_lead verdict is refused before that match, so a held route
// reports that it has no executor even when the object would also miss the registry.
const executorSchema = type({
  '+': 'reject',
  id: 'string > 0',
  providerInstanceId: 'string > 0',
  model: 'string > 0',
  options: type({ '[string]': 'string | number | boolean' }).narrow((value) => !Array.isArray(value)),
  source: "'jev' | 'default'",
})

function storedExecutor(executor, route) {
  if (executor === undefined) return {}
  if (executor === null) return { executor: null }
  if (route === 'needs_lead') jevError('a needs_lead verdict has no executor')
  const parsed = executorSchema(executor)
  if (parsed instanceof type.errors) jevError('invalid executor')
  const matched = matchStoredExecutor(parsed, route)
  if (!matched.ok) jevError(matched.message)
  return { executor: matched.executor }
}

/** Checks a verdict and returns the object stored on the task. `at` is always stamped here. */
export function normalizeVerdict(raw, now = new Date()) {
  const value = parseVerdict(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) jevError('must be an object')
  const { route, jevRoute, confidence, holds, roleFits, suggestedRole, check, reasons, answers, executor } = value
  // A verdict can only name a route decide() emits. lead_workflow and codex_* stay board routes.
  if (!JEV_ROUTES.includes(route))
    jevError(`unknown route ${JSON.stringify(route)}; a verdict route must be one of ${JEV_ROUTES.join(', ')}`)
  if (!JEV_ROUTES.includes(jevRoute))
    jevError(`unknown jevRoute ${JSON.stringify(jevRoute)}; known jev routes: ${JEV_ROUTES.join(', ')}`)
  assertConfidence(confidence)
  assertHolds(holds)
  if (holds.length > 0 && route !== 'needs_lead') jevError('holds require route needs_lead')
  if (typeof roleFits !== 'boolean') jevError('roleFits must be a boolean')
  assertSuggestedRole(suggestedRole)
  assertCheck(check)
  assertReasons(reasons)
  assertAnswers(answers)
  const storedField = storedExecutor(executor, route)
  return {
    route,
    jevRoute,
    confidence,
    holds,
    roleFits,
    suggestedRole,
    check,
    reasons,
    ...storedField,
    ...(answers === undefined ? {} : { answers }),
    at: now.toISOString(),
  }
}

function clearClaimResidue(task) {
  let cleared = false
  for (const key of CLAIM_RESIDUE) {
    if (Object.hasOwn(task, key)) {
      delete task[key]
      cleared = true
    }
  }
  return cleared
}

const RESIDUE_STATUSES = ['open', 'cancelled']

function hasClaimResidue(task) {
  return RESIDUE_STATUSES.includes(task.status) && CLAIM_RESIDUE.some((key) => Object.hasOwn(task, key))
}

/** A claimed run is current only when `run.at` is a string equal to that claim's `claimedAt`. */
function staleRun(task) {
  if (task.status !== 'claimed' || task.run == null) return false
  if (typeof task.run !== 'object' || Array.isArray(task.run)) return true
  return typeof task.run.at !== 'string' || task.run.at !== task.claimedAt
}

export function currentRun(task) {
  if (task.status !== 'claimed' || staleRun(task)) return null
  if (!task.run || typeof task.run !== 'object' || Array.isArray(task.run)) return null
  return task.run
}

function threadId(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /\s/.test(value))
    throw new Error('thread id must be non-empty, contain no whitespace, and be at most 512 characters')
  return value
}

export function readThreadId(value) {
  try {
    return threadId(value)
  } catch {
    return null
  }
}

function staleWake(task) {
  if (task.status !== 'claimed' || task.wake == null) return false
  return (
    typeof task.wake !== 'object' ||
    Array.isArray(task.wake) ||
    task.wake.at !== task.claimedAt ||
    typeof task.wake.at !== 'string'
  )
}

export function currentWake(task) {
  if (task.status !== 'claimed' || staleWake(task) || !task.wake) return null
  if (!readThreadId(task.wake.threadId)) return null
  return task.wake
}

function setClaimWake(task, wake) {
  if (wake !== null) task.wake = { threadId: wake, at: task.claimedAt }
}

function validateWake(wake) {
  if (wake !== null) threadId(wake)
}

function uniqueStrings(items) {
  const unique = []
  const seen = new Set()
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    unique.push(item)
  }
  return unique
}

function stringEvidence(task) {
  return Array.isArray(task.evidence) && task.evidence.every((item) => typeof item === 'string')
}

function dedupeEvidence(task) {
  if (!stringEvidence(task)) return false
  const unique = uniqueStrings(task.evidence)
  if (unique.length === task.evidence.length) return false
  task.evidence = unique
  return true
}

/**
 * Drops leftover claim fields on open and cancelled tasks, drops a stale run on a claimed
 * task, and dedupes string evidence. Done tasks keep their claim fields. Idempotent.
 * Pushes one heal event per kind of repair. Anything else is left for doctor.
 */
export function healBoard(board) {
  const cleared = []
  const dropped = []
  const deduped = []
  for (const task of board.tasks) {
    if (hasClaimResidue(task) && clearClaimResidue(task)) cleared.push(task.id)
    if (staleRun(task)) {
      delete task.run
      dropped.push(task.id)
    }
    if (staleWake(task)) {
      delete task.wake
      healEvents.push(`dropped stale wake on task ${task.id}`)
    }
    if (dedupeEvidence(task)) deduped.push(task.id)
  }
  if (cleared.length) healEvents.push(`cleared leftover claim fields on task(s): ${cleared.join(', ')}`)
  if (dropped.length) healEvents.push(`dropped stale run on task(s): ${dropped.join(', ')}`)
  if (deduped.length) healEvents.push(`deduped evidence on task(s): ${deduped.join(', ')}`)
  return { cleared, dropped, deduped }
}

function missingDependencies(board, after) {
  return after.filter((id) => !board.tasks.some((task) => task.id === id))
}

function addedRoute(route, storedJev) {
  if (route != null) return route
  return storedJev?.route ?? null
}

function cleanReason(reason) {
  if (reason == null) return null
  const trimmed = String(reason).trim()
  if (!trimmed) throw new Error('--reason must not be empty')
  return trimmed
}

function refuseReservedBy(by) {
  if (by == null) return
  // NFKC folds fullwidth letters; format (Cf) and nonspacing (Mn) characters render as nothing.
  const plain = String(by)
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Mn}]/gu, '')
    .trim()
    .toLowerCase()
  if (plain === 'jev') throw new Error('by jev is reserved for verdicts')
}

function journalsAddDecision(fields) {
  if (fields.route == null) return false
  return Boolean(cleanReason(fields.reason))
}

function assertAddArgs(fields) {
  refuseReservedBy(fields.by)
  if (fields.reason != null && fields.route == null) throw new Error('add --reason needs --route')
  if (fields.by == null) return
  if (!journalsAddDecision(fields)) throw new Error('add --by needs a journaled decision')
}

function applyExplicitRoute(task, route, storedJev, reason, by, now) {
  const trimmed = cleanReason(reason)
  if (route == null) return
  const from = storedJev?.route ?? null
  const differs = Boolean(storedJev) && route !== storedJev.route
  if (differs && !trimmed) throw new Error('add needs --reason when --route differs from the jev route')
  if (!trimmed) return
  appendDecision(task, {
    at: now.toISOString(),
    kind: 'route',
    from,
    to: route,
    reason: trimmed,
    by: by ?? null,
  })
}

const MAX_ACCEPT_CHARS = 600
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

function addFields(input) {
  return {
    role: input.role,
    title: input.title,
    after: input.after ?? [],
    route: input.route ?? null,
    jev: input.jev ?? null,
    reason: input.reason ?? null,
    by: input.by ?? null,
    accept: input.accept ?? null,
    tag: input.tag ?? null,
    now: input.now ?? new Date(),
  }
}

function cleanAccept(accept) {
  if (accept == null) return null
  if (typeof accept !== 'string') throw new Error('--accept must be a string')
  const trimmed = accept.trim()
  if (!trimmed) throw new Error('--accept must not be empty')
  if (trimmed.length > MAX_ACCEPT_CHARS) throw new Error(`--accept must be at most ${MAX_ACCEPT_CHARS} characters`)
  // The acceptance check is sent to Jev by jev-ask --check-evidence.
  return cleanText(trimmed, '--accept')
}

function cleanTag(tag) {
  if (tag == null) return null
  if (typeof tag !== 'string') throw new Error('--tag must be a string')
  const trimmed = tag.trim()
  if (!TAG_PATTERN.test(trimmed)) throw new Error('--tag must match /^[a-z0-9][a-z0-9-]{0,39}$/')
  return trimmed
}

function assertCatalogRole(role) {
  if (Object.hasOwn(ROLES, role)) return
  throw new Error(unknownRoleMessage(role))
}

function assertAcceptForRole(role, accept) {
  if (role === 'lead' || accept) return
  throw new Error(`add needs --accept <text> for role ${role}; pass --accept with the acceptance check`)
}

function storedAddJev(board, fields) {
  if (!fields.role || !fields.title) throw new Error('usage: add <role> <title...>')
  const missing = missingDependencies(board, fields.after)
  if (missing.length) throw new Error(`unknown dependency ids: ${missing.join(',')}`)
  if (fields.route != null) assertKnownRoute(fields.route)
  if (fields.jev == null) return null
  return normalizeVerdict(fields.jev, fields.now)
}

function blankTask(board, fields, storedJev) {
  return {
    id: board.tasks.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    role: fields.role,
    title: fields.title,
    status: 'open',
    owner: null,
    after: fields.after,
    route: addedRoute(fields.route, storedJev),
  }
}

function stampAcceptAndTag(task, accept, tag) {
  if (accept) task.accept = accept
  if (tag) task.tag = tag
}

export function addTask(board, input = {}) {
  const fields = addFields(input)
  assertAddArgs(fields)
  const storedJev = storedAddJev(board, fields)
  assertCatalogRole(fields.role)
  const accept = cleanAccept(fields.accept)
  const gitProof = input.gitProof == null ? null : normalizeGitProof(input.gitProof)
  assertAcceptForRole(fields.role, accept || gitProof)
  // A gated task's title goes to Jev with its evidence check, so it gets the same text check.
  if (accept) cleanText(fields.title, 'title')
  const tag = cleanTag(fields.tag)
  const task = blankTask(board, fields, storedJev)
  stampAcceptAndTag(task, accept, tag)
  if (gitProof) task.gitProof = gitProof
  if (input.review === true) task.reviewRequired = true
  if (storedJev) task.jev = storedJev
  applyExplicitRoute(task, fields.route, storedJev, fields.reason, fields.by, fields.now)
  board.tasks.push(task)
  return task
}

function isNewer(later, earlier) {
  const left = Date.parse(later)
  const right = Date.parse(earlier)
  return Number.isFinite(left) && Number.isFinite(right) && left > right
}

function jevMadeRoute(decision) {
  return decision.by === 'jev' && decision.reason === 'jev verdict' && Object.hasOwn(decision, 'verdict')
}

/** A lead route decision owns the route until `route` replaces it. */
function leadHoldsRoute(task, previous) {
  const decision = latestRouteDecision(task)
  if (!decision || jevMadeRoute(decision)) return false
  if (!previous || isNewer(decision.at, previous.at)) return true
  return decision.to === task.route
}

function jevRouteNote(task, previous) {
  if (task.status !== 'open') return `stored the verdict and left the route unchanged: task is ${task.status}`
  if (task.route == null && !latestRouteDecision(task)) return null
  if (task.route === 'needs_lead')
    return 'stored the verdict and left the route unchanged: only `route <id> <route> --reason` can leave needs_lead'
  if (leadHoldsRoute(task, previous))
    return 'stored the verdict and left the route unchanged: only `route <id> <route> --reason` changes it'
  if (!previous || task.route !== previous.route)
    return 'stored the verdict and left the route unchanged: the current route is not the previous verdict route'
  return null
}

function refuseFinishedJev(task) {
  if (task.status === 'done' || task.status === 'cancelled')
    throw new Error(`task ${task.id} is ${task.status}; a done or cancelled task cannot take a verdict`)
}

// The journal keeps what Jev decided, not its raw answers, so replaced verdicts do not grow the board.
function journaledVerdict(verdict) {
  if (!verdict) return null
  const { answers: _answers, ...kept } = verdict
  return kept
}

function recordReplacedVerdict(task, previous, now) {
  if (!previous) return
  appendDecision(task, { at: now.toISOString(), kind: 'jev', verdict: journaledVerdict(previous) })
}

/**
 * Stores a verdict on an open or claimed task. A done or cancelled task is refused.
 * Changes the route only when the task is open, the route is not needs_lead, no lead
 * route decision is holding it, and either the route is null with no route decision in
 * the journal or the route still equals the previous verdict's route.
 * Replacing a verdict always journals the previous one. The note is printed, not stored.
 */
export function attachJev(board, id, verdict, { now = new Date() } = {}) {
  const task = findLiveTask(board, id)
  // Shape is checked before status so a garbage verdict is refused as garbage.
  const stored = normalizeVerdict(verdict, now)
  refuseFinishedJev(task)
  const previous = task.jev ?? null
  const note = jevRouteNote(task, previous)
  recordReplacedVerdict(task, previous, now)
  task.jev = stored
  if (!note && stored.route !== task.route) {
    appendDecision(task, {
      at: now.toISOString(),
      kind: 'route',
      from: task.route ?? null,
      to: stored.route,
      reason: 'jev verdict',
      by: 'jev',
      verdict: journaledVerdict(previous),
    })
    task.route = stored.route
  }
  const printed = { ...task }
  if (note) printed.note = note
  return printed
}

/** Claims the first eligible task for `role`, or exactly task `id` when given (and fails loudly if it cannot). */
export function claimTask(board, role, owner, { id = null, now = new Date(), run = null, wake = null } = {}) {
  const parsedRun = run == null ? null : parseRun(run)
  validateWake(wake)
  let task
  if (id !== null) {
    task = findLiveTask(board, id)
    const why = whyNotClaimable(board, task, role, { allowLeadWorkflow: true })
    if (why) throw new Error(`task ${String(id)} is not claimable: ${why}`)
  } else {
    task = board.tasks.find((candidate) => whyNotClaimable(board, candidate, role) === null)
    if (!task) return null
  }
  Object.assign(task, { status: 'claimed', owner, claimedAt: now.toISOString() })
  delete task.heartbeatAt
  if (parsedRun) task.run = { ...parsedRun, at: task.claimedAt }
  else delete task.run
  delete task.wake
  setClaimWake(task, wake)
  return task
}

/** A worker's "still alive" signal. `stale` and `reap` read it. `--run` may refresh the executor link. */
export function heartbeatTask(board, id, { owner = null, now = new Date(), run = null, wake = null } = {}) {
  const parsedRun = run == null ? null : parseRun(run)
  validateWake(wake)
  const task = findLiveTask(board, id)
  if (task.status !== 'claimed')
    throw new Error(`task ${String(id)} is ${task.status}; only a claimed task has a heartbeat`)
  if (owner && task.owner !== owner)
    throw new Error(`task ${String(id)} is owned by ${task.owner}, not ${String(owner)}`)
  assertRunClaimTimestamp(task, parsedRun)
  assertWakeClaimTimestamp(task, wake)
  task.heartbeatAt = now.toISOString()
  if (parsedRun) task.run = { ...parsedRun, at: task.claimedAt }
  setClaimWake(task, wake)
  return task
}

function assertRunClaimTimestamp(task, run) {
  if (run && typeof task.claimedAt !== 'string')
    throw new Error('claim predates timestamps; release and re-claim with --run')
}

function assertWakeClaimTimestamp(task, wake) {
  if (wake !== null && typeof task.claimedAt !== 'string')
    throw new Error('claim predates timestamps; release and re-claim with --wake')
}

/**
 * @param {any} board
 * @param {any} tag
 * @param {any} record
 * @param {boolean} clear
 */
function setTagLeadWake(board, tag, record, clear) {
  const cleaned = cleanTag(tag)
  if (!cleaned) throw new Error('lead-wake --tag needs a tag')
  if (board.tagLeadWakes != null && (typeof board.tagLeadWakes !== 'object' || Array.isArray(board.tagLeadWakes)))
    throw new Error('tag lead addresses are not an object')
  if (!board.tagLeadWakes) board.tagLeadWakes = {}
  if (!clear) {
    board.tagLeadWakes[cleaned] = record
    return
  }
  delete board.tagLeadWakes[cleaned]
  if (Object.keys(board.tagLeadWakes).length === 0) delete board.tagLeadWakes
}

/**
 * @param {any} value
 * @param {any} by
 * @param {Date} now
 * @param {boolean} clear
 */
function leadWakeRecord(value, by, now, clear) {
  if (typeof by !== 'string' || !by.trim()) throw new Error('lead-wake needs --by <name>')
  if (!clear) threadId(value)
  return { threadId: value, at: now.toISOString(), by }
}

export function setLeadWake(board, value, { id = null, tag = null, by, clear = false, now = new Date() } = {}) {
  if (id !== null && tag !== null) throw new Error('lead-wake takes --task or --tag, not both')
  const record = leadWakeRecord(value, by, now, clear)
  if (tag !== null) {
    setTagLeadWake(board, tag, record, clear)
    return board
  }
  const target = id === null ? board : findLiveTask(board, id)
  if (clear) delete target.leadWake
  else target.leadWake = record
  return target
}

/**
 * The lead address a task uses: its own, then its tag's, then the board's.
 * @param {any} board
 * @param {any} task
 */
export function resolveLeadAddress(board, task) {
  const own = wakeRecord(task?.leadWake)
  if (own) return { source: 'task', ...own }
  const tag = typeof task?.tag === 'string' ? wakeRecord(board?.tagLeadWakes?.[task.tag]) : null
  if (tag) return { source: 'tag', ...tag }
  const shared = wakeRecord(board?.leadWake)
  if (shared) return { source: 'board', ...shared }
  return null
}

/** @param {any} value */
function wakeRecord(value) {
  const threadId = readThreadId(value?.threadId)
  if (!threadId) return null
  return { threadId, at: value.at, by: value.by }
}

const JUDGMENT_TOOLS = ['ask', 'decide', 'check']
const ASK_OUTCOMES = ['answered', 'hold']
const CHECK_OUTCOMES = ['confirmed', 'rejected', 'hold']
const MAX_QUESTION_CHARS = 300
const HASH_PATTERN = /^[0-9a-f]{64}$/

function judgmentError(message) {
  throw new Error(`judgment: ${message}`)
}

function parseJsonObject(raw, label) {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${label}: not valid JSON`)
  }
}

function assertJudgmentBy(by) {
  const cleaned = cleanOptionalText(by, 'by')
  if (!cleaned) judgmentError('by is required')
  refuseReservedBy(cleaned)
  return cleaned
}

function assertQuestion(question) {
  if (typeof question !== 'string') judgmentError('question must be a string')
  const trimmed = question.trim()
  if (!trimmed) judgmentError('question must not be empty')
  if (trimmed.length > MAX_QUESTION_CHARS) judgmentError(`question must be at most ${MAX_QUESTION_CHARS} characters`)
  return trimmed
}

function assertTool(tool) {
  if (!JUDGMENT_TOOLS.includes(tool)) judgmentError(`tool must be one of ${JUDGMENT_TOOLS.join(', ')}`)
  return tool
}

function assertOutcome(tool, outcome) {
  const allowed = tool === 'check' ? CHECK_OUTCOMES : ASK_OUTCOMES
  if (!allowed.includes(outcome)) judgmentError(`outcome for ${tool} must be one of ${allowed.join(', ')}`)
  return outcome
}

function assertNullableString(value, field) {
  if (value === null) return null
  if (typeof value !== 'string') judgmentError(`${field} must be a string or null`)
  const trimmed = value.trim()
  return trimmed || null
}

function assertNullableUnit(value, field) {
  if (value === null) return null
  const ok = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
  if (!ok) judgmentError(`${field} must be a number from 0 to 1 or null`)
  return value
}

function assertReasonStrings(reasons) {
  if (!Array.isArray(reasons) || reasons.some((reason) => typeof reason !== 'string'))
    judgmentError('reasons must be an array of strings')
  return reasons
}

function assertHash(hash) {
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) judgmentError('requestHash must be 64 hex characters')
  return hash
}

function assertReceipt(receipt) {
  if (typeof receipt !== 'string' || !receipt.trim()) judgmentError('receipt must be a non-empty string')
  return receipt.trim()
}

function assertJudgmentEvidence(tool, evidence) {
  if (tool !== 'check') {
    if (evidence !== undefined) judgmentError('evidence is only stored on a check')
    return undefined
  }
  if (!Array.isArray(evidence) || evidence.some((item) => typeof item !== 'string' || !item.trim()))
    judgmentError('evidence must be an array of non-empty strings')
  return evidence.map((item) => item.trim())
}

// `basis` is how many journal entries the check read through `show` before asking Jev.
function assertJudgmentBasis(tool, basis) {
  if (tool !== 'check') {
    if (basis !== undefined) judgmentError('basis is only stored on a check')
    return undefined
  }
  if (!Number.isInteger(basis) || basis < 0)
    judgmentError('basis must be the number of journal entries the check read, a non-negative integer')
  return basis
}

function assertJudgmentAnswers(answers) {
  if (answers === undefined) return
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) judgmentError('answers must be an object')
  if (JSON.stringify(answers).length > MAX_ANSWERS_CHARS)
    judgmentError(`answers must be under ${MAX_ANSWERS_CHARS} characters of JSON`)
}

function judgmentRecord(value, now, evidence, basis) {
  return {
    kind: 'judgment',
    at: now.toISOString(),
    by: assertJudgmentBy(value.by),
    tool: value.tool,
    question: assertQuestion(value.question),
    outcome: value.outcome,
    answer: assertNullableString(value.answer, 'answer'),
    p: assertNullableUnit(value.p, 'p'),
    confidence: assertNullableUnit(value.confidence, 'confidence'),
    reasons: assertReasonStrings(value.reasons),
    ...(evidence === undefined ? {} : { evidence }),
    ...(basis === undefined ? {} : { basis }),
    requestHash: assertHash(value.requestHash),
    receipt: assertReceipt(value.receipt),
    ...(value.answers === undefined ? {} : { answers: value.answers }),
  }
}

/** Checks a judgment payload and returns the journal entry. `at` is always stamped here. */
export function normalizeJudgment(raw, now = new Date()) {
  const value = parseJsonObject(raw, 'judgment')
  if (!value || typeof value !== 'object' || Array.isArray(value)) judgmentError('must be an object')
  const tool = assertTool(value.tool)
  const outcome = assertOutcome(tool, value.outcome)
  assertJudgmentAnswers(value.answers)
  const evidence = assertJudgmentEvidence(tool, value.evidence)
  const record = judgmentRecord({ ...value, tool, outcome }, now, evidence, assertJudgmentBasis(tool, value.basis))
  if (value.scope !== undefined) {
    if (tool !== 'check') judgmentError('scope is only stored on a check')
    record.scope = normalizeEvidenceScope(value.scope)
  }
  return record
}

function refuseFinished(task, action) {
  if (task.status === 'done' || task.status === 'cancelled')
    throw new Error(`task ${task.id} is ${task.status}; a done or cancelled task cannot take a ${action}`)
}

function assertGatedClaim(task, action) {
  if ((!task.accept && !task.gitProof) || task.status === 'claimed') return
  throw new Error(`task ${task.id} is ${task.status}; ${action} on a gated task needs a claim`)
}

function claimedGitTask(board, id, by) {
  const task = findLiveTask(board, id)
  if (!task.gitProof) throw new Error(`task ${id} has no pinned Git proof requirement`)
  if (!by || task.status !== 'claimed' || task.owner !== by)
    throw new Error(`task ${id} needs its claim owner to verify Git proof`)
  return task
}

export function prepareGitProof(board, id, by) {
  const task = claimedGitTask(board, id, by)
  return { by, proof: task.gitProof, basis: decisionEntries(task).length, facts: verifyGitProof(task.gitProof) }
}

export function recordGitProof(board, id, { by, proof, basis, facts, now = new Date() }) {
  const task = claimedGitTask(board, id, by)
  const decisions = decisionEntries(task)
  if (JSON.stringify(proof) !== JSON.stringify(task.gitProof) ||
    basis > decisions.length || decisions.slice(basis).some(isInvalidator))
    throw new Error(`task ${id} changed while verifying Git proof; run verify-git again`)
  appendDecision(task, { kind: 'git-proof', at: now.toISOString(), by, proof: task.gitProof, ...facts })
  return task
}

/**
 * Appends a judgment. A gated task must be claimed, and the judgment must be by its owner.
 * Done and cancelled tasks are refused.
 */
export function addJudgment(board, id, raw, { now = new Date() } = {}) {
  const task = findLiveTask(board, id)
  const judgment = normalizeJudgment(raw, now)
  refuseFinished(task, 'judgment')
  assertGatedClaim(task, 'a judgment')
  if (task.accept && judgment.by !== task.owner)
    throw new Error(`task ${task.id} is claimed by ${task.owner}; a judgment on a gated task must be by the owner`)
  refuseStaleCheck(task, judgment)
  if (judgment.tool === 'check' && task.gitProof && !judgment.scope)
    throw new Error(`task ${task.id} needs a scoped check for the pinned candidate`)
  assertEvidenceScope(task, judgment.scope)
  appendDecision(task, judgment)
  return task
}

// Register before leaving the board lock for Jev. Revalidate the snapshot so a
// release or evidence change between show and registration cannot be missed.
export function startEvidenceCheck(board, id, { by, token, evidence, basis, scope }) {
  const task = findLiveTask(board, id)
  if (!task.accept || task.status !== 'claimed' || task.owner !== by)
    throw new Error(`task ${id} is not claimed by ${by}`)
  if (
    !token ||
    !Array.isArray(evidence) ||
    !evidence.length ||
    !sameEvidence(evidence, task.evidence) ||
    basis !== decisionEntries(task).length
  )
    throw new Error(`task ${id} changed while preparing the check; run the check again`)
  if (task.pendingChecks?.length) throw new Error(`task ${id} already has an evidence check in flight`)
  assertRetainedEvidence(task)
  const checked = scope === undefined ? undefined : normalizeEvidenceScope(scope)
  assertEvidenceScope(task, checked)
  task.pendingChecks ??= []
  task.pendingChecks.push({ token, by, evidence: [...evidence], ...(checked && { scope: checked }) })
  return task
}

export function endEvidenceCheck(board, id, token) {
  const task = findLiveTask(board, id)
  task.pendingChecks = (task.pendingChecks ?? []).filter((check) => check.token !== token)
  if (!task.pendingChecks.length) delete task.pendingChecks
  return task
}

export function abandonStaleEvidenceCheck(board, id, { token, by, basis }) {
  const task = findLiveTask(board, id)
  if (task.status !== 'claimed' || task.owner !== by || decisionEntries(task).slice(basis).some(isInvalidator))
    return endEvidenceCheck(board, id, token)
  const check = task.pendingChecks?.find((entry) => entry.token === token)
  if (check?.evidence && !sameEvidence(check.evidence, task.evidence)) return endEvidenceCheck(board, id, token)
  if (check?.scope) {
    try {
      assertEvidenceScope(task, check.scope)
    } catch {
      return endEvidenceCheck(board, id, token)
    }
  }
  return task
}

// A check judged the task as `show` returned it. A release, choice, or answered ask or decide journaled after
// that read voids what the check judged, so its late answer is refused instead of counting as fresh.
function refuseStaleCheck(task, judgment) {
  if (judgment.tool !== 'check') return
  if (!sameEvidence(judgment.evidence, task.evidence))
    throw new Error(`task ${task.id} evidence changed while the check ran; run the check again`)
  const decisions = decisionEntries(task)
  if (judgment.basis > decisions.length)
    throw new Error(`task ${task.id} has fewer journal entries than the check read; run the check again`)
  if (decisions.slice(judgment.basis).some(isInvalidator))
    throw new Error(
      `task ${task.id} took a release, choice, or answered ask or decide while the check ran; run the check again`,
    )
}

/** @returns {{ evidence?: unknown, outcome?: string } | null} */
function latestCheck(task) {
  let found = null
  for (const entry of decisionEntries(task)) {
    if (entry?.kind === 'judgment' && entry.tool === 'check') found = entry
  }
  return found
}

function assertAcceptableCheck(task, check) {
  if (!check) throw new Error(`task ${task.id} has no check judgment to accept`)
  if (check.outcome === 'rejected') throw new Error(`task ${task.id} check was rejected; bring new evidence`)
  if (check.outcome === 'confirmed') throw new Error(`task ${task.id} check is already confirmed`)
  if (check.outcome !== 'hold') throw new Error(`task ${task.id} check is ${check.outcome}; accept is only for a hold`)
}

/** The lead accepts the current evidence when the latest check is a hold. */
export function acceptEvidence(board, id, { reason, by, now = new Date() } = {}) {
  const cleanedBy = cleanOptionalText(by, '--by')
  if (!cleanedBy) throw new Error('accept needs --by <name>')
  refuseReservedBy(cleanedBy)
  const trimmed = cleanReason(reason)
  if (!trimmed) throw new Error('accept needs --reason <text>')
  const task = findLiveTask(board, id)
  refuseFinished(task, 'accept')
  if (task.owner && cleanedBy === task.owner)
    throw new Error(`accept --by must differ from the task owner ${task.owner}`)
  const check = latestCheck(task)
  assertAcceptableCheck(task, check)
  const evidence = evidenceItems(task)
  if (!evidence.length) throw new Error(`task ${task.id} has no evidence to accept`)
  // The lead accepts what Jev was unsure about, not evidence added after that check.
  if (!sameEvidence(check.evidence, task.evidence))
    throw new Error(`task ${task.id} evidence changed since the last check; run the check again`)
  const decisions = decisionEntries(task)
  if (decisions.slice(decisions.lastIndexOf(check) + 1).some(invalidatesHeldCheck))
    throw new Error(`task ${task.id} decisions changed since the last check; run the check again`)
  assertRetainedEvidence(task)
  assertEvidenceScope(task, check.scope)
  const decision = { kind: 'accept', at: now.toISOString(), by: cleanedBy, reason: trimmed, evidence, ...(check.scope && { scope: check.scope }) }
  appendDecision(task, decision)
  enqueueDeliveries(board, task, decision)
  return task
}

function decisionEntries(task) {
  return Array.isArray(task.decisions) ? task.decisions : []
}

function evidenceItems(task) {
  if (!Array.isArray(task.evidence)) return []
  return task.evidence.filter((item) => typeof item === 'string')
}

function sameEvidence(left, right) {
  const a = new Set(Array.isArray(left) ? left.filter((item) => typeof item === 'string') : [])
  const b = new Set(evidenceItems({ evidence: right }))
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

function isInvalidator(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.kind === 'choice' || entry.kind === 'release') return true
  // A note that reopens finished work hands it back like a release: the next claim needs a fresh confirmation.
  if (entry.kind === 'note' && entry.reopened) return true
  const answered = entry.kind === 'judgment' && entry.outcome === 'answered'
  return answered && (entry.tool === 'ask' || entry.tool === 'decide')
}

// A release hands the task back but leaves a held check for the lead to resolve; any other invalidator changed
// what the check judged.
function invalidatesHeldCheck(entry) {
  return entry?.kind !== 'release' && isInvalidator(entry)
}

function confirmsEvidence(entry, evidence) {
  if (!entry || typeof entry !== 'object') return false
  const check = entry.kind === 'judgment' && entry.tool === 'check' && entry.outcome === 'confirmed'
  if (!check && entry.kind !== 'accept') return false
  return sameEvidence(entry.evidence, evidence)
}

function isEvidenceVerdict(entry, evidence) {
  if (!entry || typeof entry !== 'object') return false
  const check = entry.kind === 'judgment' && entry.tool === 'check'
  return (check || entry.kind === 'accept') && sameEvidence(entry.evidence, evidence)
}

// The latest check or accept for the current evidence decides: a later rejection or hold voids an earlier
// confirmation. A confirming entry is fresh only while no choice, release or answered ask/decide follows it.
function hasFreshConfirmation(task) {
  const decisions = decisionEntries(task)
  const index = decisions.findLastIndex((entry) => isEvidenceVerdict(entry, task.evidence))
  if (index < 0 || !confirmsEvidence(decisions[index], task.evidence)) return false
  return !decisions.slice(index + 1).some(isInvalidator)
}

function isOpenHold(entry) {
  return entry?.kind === 'judgment' && entry.outcome === 'hold' && (entry.tool === 'ask' || entry.tool === 'decide')
}

function hasOpenHold(task) {
  const decisions = decisionEntries(task)
  return decisions.some(
    (entry, index) => isOpenHold(entry) && !decisions.slice(index + 1).some((later) => later?.kind === 'choice'),
  )
}

/**
 * What holds an open or claimed task for the owner, or null. A question to the owner comes first; then an ask or
 * decide hold with no later choice. Otherwise, unless a fresh confirmation covers the current evidence, the latest
 * check decides when it judged that evidence: a hold waits for the lead's accept until a decision other than a
 * release changes what it judged, a rejection for new evidence or a release. `entry` is the journal entry behind
 * it. scripts/board-projection.mjs keeps a copy of these rules, and scripts/team-board-gate.test.ts and
 * scripts/team-board-view.test.ts hold it to this one.
 */
export function ownerGate(task) {
  if (task.status !== 'open' && task.status !== 'claimed') return null
  const decisions = decisionEntries(task)
  if (ownerThread(task).question === 'Asked')
    return { why: 'question', tool: null, entry: decisions.findLast((entry) => entry?.kind === 'owner-ask') }
  if (hasOpenHold(task)) {
    const entry = decisions.findLast(
      (held, index) => isOpenHold(held) && !decisions.slice(index + 1).some((later) => later?.kind === 'choice'),
    )
    return { why: 'hold', tool: entry.tool, entry }
  }
  if (hasFreshConfirmation(task)) return null
  const check = latestCheck(task)
  if (!check || !sameEvidence(check.evidence, task.evidence)) return null
  const later = decisions.slice(decisions.lastIndexOf(check) + 1)
  if (check.outcome === 'hold' && !later.some(invalidatesHeldCheck)) return { why: 'hold', tool: 'check', entry: check }
  if (check.outcome === 'rejected' && !later.some((entry) => entry?.kind === 'release'))
    return { why: 'rejected', tool: 'check', entry: check }
  return null
}

/**
 * [] means the task may be marked done. A task with no accept skips the evidence gate, but no task finishes
 * over an owner thread that is still open (ownerThread).
 */
export function doneBlockers(task) {
  const blockers = []
  if (task?.gitProof) {
    const decisions = decisionEntries(task)
    const proof = decisions.findLastIndex((entry) => entry?.kind === 'git-proof')
    if (proof < 0 || JSON.stringify(decisions[proof].proof) !== JSON.stringify(task.gitProof) ||
      decisions.slice(proof + 1).some(isInvalidator))
      blockers.push('NeverDoneWithoutGitProof: run verify-git against the pinned requirement')
  }
  if (!task?.accept && !task?.gitProof) return [...ownerThreadBlockers(task), ...reviewBlockers(task)]
  if (task.accept) {
    if (!evidenceItems(task).length) blockers.push('NeverDoneUnchecked: no evidence')
    if (!hasFreshConfirmation(task))
      blockers.push('NeverDoneUnconfirmed: no confirmed check or accept for the current evidence')
  }
  if (hasOpenHold(task)) blockers.push('NeverDoneWhileHeld: an ask or decide hold has no later choice')
  if (task.pendingChecks?.some((check) => check.by === task.owner))
    blockers.push('NeverDoneWhileAskingJev: an evidence check is in flight')
  return [...blockers, ...ownerThreadBlockers(task), ...reviewBlockers(task)]
}

export function needsFix(finding) {
  return finding.frequency * finding.impact >= 20 || (finding.frequency >= 1 && finding.impact >= 8)
}

export function reviewBlockers(task) {
  if (!task?.review)
    return task?.reviewRequired ? ['NeverDoneWithoutReview: submit review findings, including an empty list'] : []
  return task.review.findings.flatMap((finding) => {
    const status = finding.disposition.status
    return status === 'pending' || status === 'blocked'
      ? [`NeverDoneWithUnresolvedReview: ${finding.id} is ${status}`]
      : []
  })
}

export function reviewReport(task) {
  const findings = (task.review?.findings ?? []).map((finding) => ({
    ...finding,
    product: finding.frequency * finding.impact,
    qualifies: needsFix(finding),
  }))
  return {
    taskId: task.id,
    reviewer: task.review?.by ?? null,
    complete: reviewBlockers(task).length === 0,
    findings,
    unfixed: findings.filter((finding) => finding.disposition.status !== 'fixed'),
  }
}

/** @param {import('./team-review.mjs').reviewSchema.infer} review */
export function recordReview(board, id, review, by) {
  const task = findLiveTask(board, id)
  refuseFinished(task, 'review')
  if (task.status !== 'claimed' || task.owner !== by) throw new Error('only the claim owner may submit the review')
  const previous = task.review?.findings ?? []
  for (const finding of previous) {
    const next = review.findings.find((next) => next.id === finding.id)
    if (!next) throw new Error(`review must retain finding ${finding.id}; update its disposition instead`)
    for (const field of ['comment', 'conditions', 'frequency', 'impact', 'rationale']) {
      if (next[field] !== finding[field])
        throw new Error(
          `review must preserve ${field} for finding ${finding.id}; only disposition and cross-check may change`,
        )
    }
  }
  decideTask(board, id, { summary: 'Recorded scored review; re-check acceptance evidence', by })
  task.reviewRequired = true
  task.review = { ...review, by }
  return task
}

/** The latest check whose evidence set equals the task's current evidence, or null. */
export function currentCheck(task) {
  let found = null
  for (const entry of decisionEntries(task)) {
    if (entry?.kind === 'judgment' && entry.tool === 'check' && sameEvidence(entry.evidence, task.evidence))
      found = entry
  }
  return found
}

function assertDoneAble(task) {
  if (task.status === 'done') return
  const blockers = doneBlockers(task)
  if (blockers.length) throw new Error(`task ${task.id} is not done-able: ${blockers.join('; ')}`)
  const verdict = decisionEntries(task).findLast((entry) => isEvidenceVerdict(entry, task.evidence))
  assertEvidenceScope(task, verdict?.scope)
}

function trimmedEvidenceItem(item) {
  if (typeof item !== 'string') throw new Error('evidence items must be non-empty strings')
  const trimmed = item.trim()
  if (!trimmed) throw new Error('evidence items must be non-empty strings')
  if (trimmed.startsWith('--')) throw new Error('evidence items must not start with --')
  return trimmed
}

// A gated task swaps a same-named legacy path for its retained copy when the bytes match.
function replaceLegacyEvidence(existing, items) {
  const next = [...existing]
  for (const raw of items) {
    const item = trimmedEvidenceItem(raw)
    if (!retainedEvidenceIntact(item)) continue
    const contentId = retainedEvidenceContentId(item)
    for (let i = 0; i < next.length; i++) {
      const old = next[i]
      if (retainedEvidenceContentId(old) !== null || basename(old) !== basename(item)) continue
      if (legacyEvidenceMatches(old, contentId)) next[i] = item
    }
  }
  return next
}

function appendEvidence(task, items, field = 'evidence') {
  if (task.status === 'cancelled')
    throw new Error(`task ${task.id} is cancelled; a cancelled task cannot take evidence`)
  assertGatedClaim(task, 'evidence')
  if (task[field] != null && !Array.isArray(task[field]))
    throw new Error(`task ${task.id} has evidence that is not a list`)
  if (Array.isArray(task[field]) && task[field].some((item) => typeof item !== 'string'))
    throw new Error(`task ${task.id} has evidence that is not all strings`)
  const current = Array.isArray(task[field]) ? task[field] : []
  const existing = task.accept ? replaceLegacyEvidence(current, items) : current
  const seen = new Set(existing)
  const next = [...seen]
  for (const item of items) {
    const trimmed = trimmedEvidenceItem(item)
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    next.push(trimmed)
  }
  task[field] = next
}

export function addEvidence(board, id, items, { supporting = false } = {}) {
  if (!items?.length) throw new Error('usage: evidence <id> <item...>')
  const task = findLiveTask(board, id)
  appendEvidence(task, items, supporting ? 'supportingEvidence' : 'evidence')
  return task
}

function refuseOtherOwner(task, id, owner) {
  if (owner && task.owner !== owner)
    throw new Error(`task ${String(id)} is owned by ${task.owner}, not ${String(owner)}`)
}

function assertDoneAllowed(task, id, owner, force) {
  if (force) return
  if (task.status === 'done') {
    if (task.owner != null) refuseOtherOwner(task, id, owner)
    return
  }
  if (task.status !== 'claimed')
    throw new Error(`task ${String(id)} is ${task.status}, not claimed; claim it first (or --force)`)
  refuseOtherOwner(task, id, owner)
}

function recordStop(board, task, entry, by) {
  appendDecision(task, entry)
  if (by && by !== task.owner) enqueueDeliveries(board, task, entry)
}

function recordDoneStop(board, task, by, now) {
  if (!by || by === task.owner) return
  const wake = currentWake(task)
  recordStop(board, task, { kind: 'done', at: now.toISOString(), by, ...(wake ? { wake } : {}) }, by)
}

export function doneTask(board, id, { owner = null, by = null, force = false, now = new Date(), evidence = [] } = {}) {
  const task = findLiveTask(board, id)
  assertDoneAllowed(task, id, owner, force)
  if (evidence.length) appendEvidence(task, evidence)
  if (task.status === 'done') return task
  assertDoneAble(task)
  if (task.accept) assertRetainedEvidence(task)
  recordDoneStop(board, task, by, now)
  task.status = 'done'
  task.doneAt = now.toISOString()
  settleClaimOnlyDeliveries(task, now)
  if (task.reviewRequired) task.completionReport = reviewReport(task)
  return task
}

export function releaseTask(board, id, { now = new Date(), by = null, reason = null } = {}) {
  const task = findLiveTask(board, id)
  if (task.status !== 'claimed') throw new Error(`task ${id} is ${task.status}; only a claimed task can be released`)
  const entry = {
    kind: 'release',
    at: now.toISOString(),
    owner: task.owner ?? null,
    ...(currentWake(task) ? { wake: currentWake(task) } : {}),
    ...(by !== null ? { by } : {}),
    ...(reason !== null ? { reason } : {}),
  }
  recordStop(board, task, entry, by)
  Object.assign(task, { status: 'open', owner: null })
  delete task.pendingChecks
  clearClaimResidue(task)
  settleClaimOnlyDeliveries(task, now)
  return task
}

/** A cancel ends any question to the owner. It waits while a note from the owner sits unread. */
export function cancelTask(board, id, { now = new Date(), by = null, reason = null } = {}) {
  const task = findLiveTask(board, id)
  if (task.status === 'done') throw new Error(`task ${id} is done; a done task cannot be cancelled`)
  if (ownerThread(task).note === 'NoteQueued')
    throw new Error(`task ${id} has an unread note from the owner; read it first (note-read ${id} --by <name>)`)
  if (task.status !== 'cancelled') {
    const entry = {
      kind: 'cancel',
      at: now.toISOString(),
      ...(currentWake(task) ? { wake: currentWake(task) } : {}),
      ...(by !== null ? { by } : {}),
      ...(reason !== null ? { reason } : {}),
    }
    recordStop(board, task, entry, by)
  }
  Object.assign(task, { status: 'cancelled', owner: null })
  clearClaimResidue(task)
  settleClaimOnlyDeliveries(task, now)
  return task
}

// ---------------------------------------------------------------- owner thread

// A question to the owner, the owner's answer, and a note the owner queues to the lead, as agreed in
// skills/verify-team-board/SKILL.md. These entries are their own region of the task:
// hasOpenHold and hasFreshConfirmation never match them, so an answer or a note neither confirms evidence nor
// holds it. The one crossing is a note that reopens finished work: isInvalidator treats it like a release, so the
// next claim needs a fresh confirmation. Each command checks its own precondition; the fold only reads the journal.
const THREAD_STEPS = {
  'owner-ask': (s) => ({ ...s, question: 'Asked' }),
  'owner-answer': (s) => ({ ...s, question: 'Answered' }),
  note: (s) => ({ question: s.question === 'Asked' ? 'HandedToLead' : s.question, note: 'NoteQueued' }),
  'note-read': (s) => ({ ...s, note: 'NoteRead' }),
  'lead-reply': (s) => ({ question: s.question === 'HandedToLead' ? 'Answered' : s.question, note: 'NoNote' }),
  'answer-read': (s) => ({ ...s, question: 'NoAsk' }),
  cancel: (s) => ({ ...s, question: 'NoAsk' }),
}

/** Where the journal leaves the owner's question (NoAsk, Asked, HandedToLead, Answered) and note (NoNote, NoteQueued, NoteRead). */
export function ownerThread(task) {
  let state = { question: 'NoAsk', note: 'NoNote' }
  for (const entry of decisionEntries(task)) {
    const step = Object.hasOwn(THREAD_STEPS, entry?.kind ?? '') ? THREAD_STEPS[entry.kind] : null
    if (step) state = step(state)
  }
  return state
}

const QUESTION_BLOCKERS = {
  Asked: 'NeverDoneOverYourQuestion: a question to the owner is open; the owner answers it or queues it to the lead',
  HandedToLead: 'NeverDoneOverHandoff: the owner handed a question to the lead; the lead answers it with lead-reply',
  Answered: 'NeverDoneOverUnreadAnswer: the question has an answer the worker has not read; run answer-read',
}
const NOTE_BLOCKERS = {
  NoteQueued:
    'NeverDoneOverNote: the owner queued a note to the lead; the lead reads it (note-read) and replies (lead-reply)',
  NoteRead: "NeverDoneOverNote: the lead read the owner's note and has not replied; run lead-reply",
}

function ownerThreadBlockers(task) {
  const { question, note } = ownerThread(task)
  return [QUESTION_BLOCKERS[question], NOTE_BLOCKERS[note]].filter(Boolean)
}

// Thread text may later be relayed to Jev, so it passes the same guard as a task title: at most 4,000 characters,
// no credential shapes, no binary data. Text that renders as nothing counts as empty.
function threadText(text, usage) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.replace(/[\p{Cf}\s]/gu, '')) throw new Error(usage)
  if (trimmed.startsWith('--')) throw new Error('the text must not start with --')
  return cleanText(trimmed, 'the text')
}

function refuseText(text, usage) {
  if (String(text ?? '').trim()) throw new Error(usage)
}

function threadBy(by, usage) {
  const cleaned = cleanOptionalText(by, '--by')
  if (!cleaned) throw new Error(usage)
  refuseReservedBy(cleaned)
  return cleaned
}

function refuseQuestion(task, id, want, verb) {
  const { question } = ownerThread(task)
  if (question !== want) throw new Error(`task ${id} has question state ${question}; ${verb} needs ${want}`)
}

const packetFields = {
  '+': 'reject',
  area: 'string > 0',
  lead: 'string > 0',
  priority: "'urgent' | 'blocked' | 'review' | 'idea'",
  priorityReason: 'string > 0',
  recommendation: 'string > 0',
  scope: 'string > 0',
  alternatives: 'string[]',
  checks: 'string[]',
}
const reviewPacketSchema = type.or(
  { ...packetFields, kind: "'decision' | 'idea'" },
  { ...packetFields, kind: "'product'", candidate: 'string > 0', screenshots: 'string[] > 0', 'video?': 'string > 0' },
)

export function parseReviewPacket(raw) {
  const packet = reviewPacketSchema(raw)
  if (packet instanceof type.errors) throw new Error(`invalid review packet: ${packet.summary}`)
  cleanText(JSON.stringify(packet), 'review packet')
  if (
    packet.kind === 'product' &&
    (!packet.screenshots.every((path) => reviewMediaType(path)?.startsWith('image/')) ||
      (packet.video !== undefined && !reviewMediaType(packet.video)?.startsWith('video/')))
  )
    throw new Error('review media needs PNG/JPEG/WebP screenshots and, if supplied, an MP4/WebM video')
  return packet
}

function assertReviewMedia(packet, task) {
  if (packet.kind === 'product') {
    const media = packet.video ? [...packet.screenshots, packet.video] : packet.screenshots
    for (const path of media) {
      if (!task.evidence?.includes(path)) throw new Error('review media must already be attached as task evidence')
    }
  }
}

function assertReviewRevision(task, expected) {
  if (expected !== null && expected !== reviewRevision(task))
    throw new Error('review changed; refresh and review the current question and evidence before replying')
}

/** A worker or the lead asks the owner something on a claimed task. One question is open at a time. */
export function askOwner(board, id, { text, by, packet, now = new Date() } = {}) {
  const usage = 'usage: ask-owner <id> <question...> --by <name>'
  const entry = { kind: 'owner-ask', at: now.toISOString(), by: threadBy(by, usage), text: threadText(text, usage) }
  const task = findLiveTask(board, id)
  if (task.status !== 'claimed') throw new Error(`task ${id} is ${task.status}; only a claimed task can ask the owner`)
  refuseQuestion(task, id, 'NoAsk', 'ask-owner')
  if (packet !== undefined) {
    assertReviewMedia(packet, task)
    entry.packet = packet
  }
  appendDecision(task, entry)
  return task
}

/** The owner answers the open question on the task. Like accept, the worker on the claim cannot answer itself. */
export function answerOwner(board, id, { text, by, expected = null, now = new Date() } = {}) {
  const usage = 'usage: answer <id> <answer...> --by <name>'
  const entry = { kind: 'owner-answer', at: now.toISOString(), by: threadBy(by, usage), text: threadText(text, usage) }
  const task = findLiveTask(board, id)
  assertReviewRevision(task, expected)
  refuseQuestion(task, id, 'Asked', 'answer')
  const asker = decisionEntries(task).findLast((e) => e?.kind === 'owner-ask')?.by
  if (entry.by === task.owner || entry.by === asker)
    throw new Error(`answer --by must differ from the task owner and the asker (${entry.by})`)
  appendDecision(task, entry)
  enqueueDeliveries(board, task, entry)
  return task
}

/**
 * The owner queues a note to the lead. An open question goes with it, for the lead to answer. A note on a done
 * or cancelled task reopens it, so it never sits unread on finished work.
 * @param {*} board
 * @param {number} id
 * @param {{ text?: string, by?: string, expected?: string | null, now?: Date }} [options]
 */
export function noteToLead(board, id, { text, by, expected = null, now = new Date() } = {}) {
  const usage = 'usage: note <id> <note...> --by <name>'
  const entry = { kind: 'note', at: now.toISOString(), by: threadBy(by, usage), text: threadText(text, usage) }
  const task = findLiveTask(board, id)
  assertReviewRevision(task, expected)
  const reopened = task.status === 'done' || task.status === 'cancelled' ? task.status : null
  const decision = reopened ? { ...entry, reopened } : entry
  appendDecision(task, decision)
  if (reopened) {
    Object.assign(task, { status: 'open', owner: null })
    delete task.doneAt
    clearClaimResidue(task)
  }
  enqueueDeliveries(board, task, decision)
  return task
}

/** The lead marks the owner's note read. */
export function readNote(board, id, { text, by, now = new Date() } = {}) {
  const usage = 'usage: note-read <id> --by <name>'
  refuseText(text, usage)
  const entry = { kind: 'note-read', at: now.toISOString(), by: threadBy(by, usage) }
  const task = findLiveTask(board, id)
  const { note } = ownerThread(task)
  if (note !== 'NoteQueued') throw new Error(`task ${id} has note state ${note}; note-read needs NoteQueued`)
  appendDecision(task, entry)
  return task
}

/** The lead replies to the owner: it answers a handed question and closes the owner's note. */
export function leadReply(board, id, { text, by, now = new Date() } = {}) {
  const usage = 'usage: lead-reply <id> <reply...> --by <name>'
  const entry = { kind: 'lead-reply', at: now.toISOString(), by: threadBy(by, usage), text: threadText(text, usage) }
  const task = findLiveTask(board, id)
  const { question, note } = ownerThread(task)
  if (question !== 'HandedToLead' && note === 'NoNote')
    throw new Error(`task ${id} has no handed question and no note from the owner to reply to`)
  appendDecision(task, entry)
  if (question === 'HandedToLead') enqueueDeliveries(board, task, entry)
  return task
}

/** The worker on the claim has read the answer to its question. */
export function readAnswer(board, id, { text, by, now = new Date() } = {}) {
  const usage = 'usage: answer-read <id> --by <name>'
  refuseText(text, usage)
  const entry = { kind: 'answer-read', at: now.toISOString(), by: threadBy(by, usage) }
  const task = findLiveTask(board, id)
  if (task.status !== 'claimed') throw new Error(`task ${id} is ${task.status}; the worker on a claim reads the answer`)
  refuseQuestion(task, id, 'Answered', 'answer-read')
  appendDecision(task, entry)
  return task
}

const latestText = (task, kinds) => decisionEntries(task).findLast((entry) => kinds.includes(entry?.kind))?.text ?? null

/** Who owes the next move on each owner thread: the owner, the lead, or the worker on the claim. */
export function ownerInbox(board) {
  const inbox = { owner: [], lead: [], worker: [] }
  for (const task of board.tasks) {
    if (task.archived === true) continue
    const { question, note } = ownerThread(task)
    if (question === 'NoAsk' && note === 'NoNote') continue
    const row = {
      id: task.id,
      title: task.title,
      status: task.status,
      owner: task.owner ?? null,
      question,
      note,
      askText: question === 'NoAsk' ? null : latestText(task, ['owner-ask']),
    }
    if (question === 'Asked') inbox.owner.push(row)
    if (question === 'HandedToLead' || note !== 'NoNote')
      inbox.lead.push({ ...row, noteText: latestText(task, ['note']) })
    if (question === 'Answered')
      inbox.worker.push({ ...row, answerText: latestText(task, ['owner-answer', 'lead-reply']) })
  }
  return inbox
}

function appendDecision(task, decision) {
  if (task.decisions != null && !Array.isArray(task.decisions))
    throw new Error(`task ${task.id} has decisions that are not a list`)
  task.decisions = [...(task.decisions ?? []), decision]
}

function routeReasonWhy(task, route) {
  const held = task.route === 'needs_lead'
  const overrides = Boolean(task.jev) && typeof task.jev.route === 'string' && route !== task.jev.route
  const leadHeld = leadHoldsRoute(task, task.jev ?? null) && route !== task.route
  return [
    held ? 'it is held for the lead' : null,
    overrides ? `this route overrides the jev route ${JSON.stringify(task.jev.route)}` : null,
    leadHeld ? 'a lead route decision holds the current route' : null,
  ]
    .filter(Boolean)
    .join(', and ')
}

export function routeTask(board, id, route, { reason = null, by = null, now = new Date() } = {}) {
  if (!route) throw new Error('usage: route <id> <route> [--reason <text>] [--by <owner>]')
  refuseReservedBy(by)
  assertKnownRoute(route)
  const trimmed = cleanReason(reason)
  const task = findLiveTask(board, id)
  if (task.status !== 'open') throw new Error(`task ${id} is ${task.status}; only an open task can be re-routed`)
  const why = routeReasonWhy(task, route)
  if (why && !trimmed) throw new Error(`task ${id} needs --reason: ${why}`)
  appendDecision(task, {
    at: now.toISOString(),
    kind: 'route',
    from: task.route ?? null,
    to: route,
    reason: trimmed,
    by: by ?? null,
  })
  task.route = route
  return task
}

function cleanSummary(summary) {
  if (!summary) throw new Error('usage: decide <id> --summary <text> [--ref <path>] [--by <owner>]')
  const trimmed = String(summary).trim()
  if (!trimmed) throw new Error('--summary must not be empty')
  return trimmed
}

function cleanOptionalText(value, flag) {
  if (value == null) return null
  const trimmed = String(value).trim()
  if (!trimmed) throw new Error(`${flag} must not be empty`)
  return trimmed
}

/** Records a choice (for example a Jev-scored option) on any task that is not cancelled. */
export function decideTask(board, id, { summary, ref = null, by = null, now = new Date() } = {}) {
  const trimmed = cleanSummary(summary)
  const cleanedRef = cleanOptionalText(ref, '--ref')
  const cleanedBy = cleanOptionalText(by, '--by')
  refuseReservedBy(cleanedBy)
  const task = findLiveTask(board, id)
  if (task.status === 'cancelled') throw new Error(`task ${id} is cancelled; a cancelled task cannot take a decision`)
  appendDecision(task, {
    at: now.toISOString(),
    kind: 'choice',
    summary: trimmed,
    ref: cleanedRef,
    by: cleanedBy,
  })
  return task
}

function hasCycleFrom(board, startId) {
  const after = new Map(board.tasks.map((task) => [task.id, task.after ?? []]))
  const visiting = new Set()
  const visited = new Set()
  const walk = (id) => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of after.get(id) ?? []) if (walk(next)) return true
    visiting.delete(id)
    visited.add(id)
    return false
  }
  return walk(startId)
}

/** Re-plans an open task's dependencies, e.g. when one of them was cancelled and would block it forever. */
export function setDependencies(board, id, after) {
  const task = findLiveTask(board, id)
  if (task.status !== 'open') throw new Error(`task ${id} is ${task.status}; only an open task can be re-planned`)
  const missing = after.filter((dependency) => !board.tasks.some((candidate) => candidate.id === dependency))
  if (missing.length) throw new Error(`unknown dependency ids: ${missing.join(',')}`)
  if (after.includes(id)) throw new Error(`task ${id} cannot depend on itself`)
  const previous = task.after
  task.after = after
  if (hasCycleFrom(board, id)) {
    task.after = previous
    throw new Error(`those dependencies would make task ${id} wait on itself through a cycle`)
  }
  return task
}

// ---------------------------------------------------------------- stale claims

export const lastSignal = (task) => task.heartbeatAt ?? task.claimedAt ?? null

const wakeProbe = (task, probes) => probes?.[currentWake(task)?.threadId]

const claimAgeHours = (signal, now) => (signal ? (now.getTime() - Date.parse(signal)) / 3_600_000 : null)

/**
 * Claimed tasks with no sign of life for `hours`. A claim with no timestamp (made before they existed) has unknown age.
 * With `probes` (see `runHealth`), a claim whose T3 thread is ended or missing is listed whatever its age, and every
 * claim with a read thread carries `runState`.
 */
export function staleClaims(board, { hours = 24, now = new Date(), probes = null } = {}) {
  const claims = []
  for (const task of board.tasks) {
    if (task.status !== 'claimed') continue
    const signal = lastSignal(task)
    const ageHours = claimAgeHours(signal, now)
    const probe = wakeProbe(task, probes)
    if (ageHours !== null && ageHours < hours && !probeDead(probe)) continue
    claims.push({
      id: task.id,
      role: task.role,
      owner: task.owner,
      title: task.title,
      lastSignal: signal,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      run: currentRun(task),
      ...runStateOf(probe),
    })
  }
  return claims
}

/**
 * Returns timed-out claims to open so another worker can take them. The lead must have confirmed the old
 * executor stopped. Claims of unknown age are skipped unless `includeUntimed`, because that is how another
 * team's live work looks.
 */
export function reapClaims(board, { hours, role = null, includeUntimed = false, now = new Date() }) {
  if (!(hours > 0)) throw new Error('reap needs --older-than <hours>')
  const reaped = []
  for (const claim of staleClaims(board, { hours, now })) {
    if (role && claim.role !== role) continue
    if (claim.ageHours === null && !includeUntimed) continue
    reaped.push(releaseTask(board, claim.id))
  }
  return reaped
}

// ---------------------------------------------------------------- doctor

/** Read-only findings about the board's content. `level: 'error'` makes `doctor` exit 1. */
function offCatalogRoleFindings(board) {
  const active = board.tasks.filter(
    (task) => (task.status === 'open' || task.status === 'claimed') && !Object.hasOwn(ROLES, task.role),
  )
  return active.map((task) =>
    finding(
      'info',
      'off-catalog-role',
      `task ${task.id} role ${JSON.stringify(task.role)} is not in the catalog (${Object.keys(ROLES).join(', ')})`,
      { id: task.id },
    ),
  )
}

export function analyzeBoard(board, { now = new Date() } = {}) {
  return [
    ...integrityFindings(board),
    ...dependencyFindings(board),
    ...claimFindings(board, now),
    ...heldFindings(board),
    ...journalFindings(board, now),
    ...offCatalogRoleFindings(board),
    ...openHoldFindings(board),
    ...doneUnconfirmedFindings(board),
    ...volatileEvidenceFindings(board),
  ]
}

function volatileHits(task) {
  const hits = []
  for (const item of evidenceItems(task)) if (isVolatilePath(item)) hits.push(item)
  for (const entry of decisionEntries(task)) {
    if (entry?.kind === 'choice' && typeof entry.ref === 'string' && isVolatilePath(entry.ref)) hits.push(entry.ref)
  }
  return hits
}

function volatileEvidenceFindings(board) {
  return board.tasks.filter(isActiveTask).flatMap((task) => {
    const hits = volatileHits(task)
    if (!hits.length) return []
    return [
      finding('warn', 'volatile-evidence', `task ${task.id} still points at a temp path: ${hits.join(', ')}`, {
        id: task.id,
      }),
    ]
  })
}

function openHoldFindings(board) {
  return board.tasks
    .filter((task) => (task.status === 'open' || task.status === 'claimed') && hasOpenHold(task))
    .map((task) =>
      finding('info', 'open-hold', `task ${task.id} has an open Jev hold waiting for the lead`, { id: task.id }),
    )
}

function doneUnconfirmedFindings(board) {
  return board.tasks
    .filter((task) => task.status === 'done' && (task.accept || task.gitProof) && doneBlockers(task).length)
    .map((task) =>
      finding(
        'warn',
        'done-unconfirmed',
        `task ${task.id} is done with acceptance blockers still open: ${doneBlockers(task).join('; ')}`,
        { id: task.id },
      ),
    )
}

const finding = (level, code, message, extra = {}) => ({ level, code, message, ...extra })

function integrityFindings(board) {
  const findings = []
  const seen = new Set()
  for (const task of board.tasks) {
    if (seen.has(task.id))
      findings.push(finding('error', 'duplicate-id', `task id ${task.id} appears more than once`, { id: task.id }))
    seen.add(task.id)
    if (!STATUSES.includes(task.status))
      findings.push(
        finding('error', 'bad-status', `task ${task.id} has invalid status ${JSON.stringify(task.status)}`, {
          id: task.id,
        }),
      )
    if (task.status === 'claimed' && !task.owner)
      findings.push(
        finding('error', 'claimed-no-owner', `task ${task.id} is claimed by nobody`, { id: task.id, fixable: true }),
      )
  }
  return findings
}

function dependencyFindings(board) {
  const findings = []
  const byId = new Map(board.tasks.map((task) => [task.id, task]))
  for (const task of board.tasks.filter((candidate) => ['open', 'claimed'].includes(candidate.status))) {
    for (const dep of task.after ?? []) {
      const target = byId.get(dep)
      if (!target) {
        findings.push(
          finding('error', 'unknown-dependency', `task ${task.id} waits on task ${dep}, which does not exist`, {
            id: task.id,
          }),
        )
      } else if (target.status === 'cancelled') {
        findings.push(
          finding(
            'warn',
            'blocked-by-cancelled',
            `task ${task.id} waits on cancelled task ${dep} and will never become claimable; re-plan it with \`after ${task.id} <ids>\``,
            { id: task.id },
          ),
        )
      }
    }
    if (task.status === 'open' && hasCycleFrom(board, task.id))
      findings.push(
        finding('error', 'dependency-cycle', `task ${task.id} is part of a dependency cycle`, { id: task.id }),
      )
  }
  return findings
}

function runLabel(run) {
  if (!run || typeof run !== 'object' || typeof run.kind !== 'string' || typeof run.ref !== 'string' || !run.ref)
    return null
  return `${run.kind}:${run.ref}`
}

const UNLINKED_LISTED = 20

/** Distinct thread ids of the current wake threads of claimed tasks: the ids `--runs` asks T3 about. */
export function runProbeTargets(board) {
  const ids = new Set()
  for (const task of board.tasks) {
    const wake = currentWake(task)
    if (wake) ids.add(wake.threadId)
  }
  return [...ids]
}

/** A thread is running only when T3 reports a non-empty `activeRunId`; its `state` string is quoted as given. */
const probeRunning = (probe) => typeof probe.activeRunId === 'string' && probe.activeRunId !== ''

/** `{runState}`: `missing` or T3's own state string; empty when the probe does not say what the thread is doing. */
function runStateOf(probe) {
  if (!probe || 'error' in probe) return {}
  return { runState: 'missing' in probe ? 'missing' : probe.state }
}

/** True for a probe that proves the run is over: the thread is gone or has no active run. */
const probeDead = (probe) => Boolean(probe) && !('error' in probe) && ('missing' in probe || !probeRunning(probe))

function minutesAgo(iso, now) {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? Math.max(0, Math.round((now.getTime() - time) / 60_000)) : null
}

/** The warning for one claim whose thread was read, or null when it is running. */
function deadRunFinding(task, wake, probe, now) {
  if ('missing' in probe)
    return finding(
      'warn',
      'run-missing',
      `task ${task.id} (${task.owner}): T3 has no thread ${wake.threadId}; the worker is not working on it. \`release ${task.id}\` or re-dispatch.`,
      { id: task.id },
    )
  if (probeRunning(probe)) return null
  const since = probe.updatedAt ? ` since ${probe.updatedAt}` : ''
  const ago = probe.updatedAt ? minutesAgo(probe.updatedAt, now) : null
  return finding(
    'warn',
    'run-ended',
    `task ${task.id} (${task.owner}): its T3 thread is ${probe.state}${since}${ago === null ? '' : ` (${ago} min ago)`}; the worker is not working on it. Read the thread, then \`release ${task.id}\` or re-dispatch.`,
    { id: task.id },
  )
}

function runSummaryFindings(unchecked, unlinked) {
  const findings = []
  if (unchecked.length)
    findings.push(
      finding(
        'info',
        'runs-unchecked',
        `could not read the T3 thread of ${unchecked.length} claimed task(s): ${unchecked.join(', ')}`,
      ),
    )
  if (unlinked.length) {
    const listed = unlinked.slice(0, UNLINKED_LISTED).join(', ')
    const rest = unlinked.length > UNLINKED_LISTED ? ` and ${unlinked.length - UNLINKED_LISTED} more` : ''
    findings.push(
      finding(
        'info',
        'run-unlinked',
        `${unlinked.length} claimed task(s) have a t3_task run but no wake thread, so their run cannot be checked: ${listed}${rest}. Claim with \`--wake <childThreadId>\` so the board can check the run.`,
      ),
    )
  }
  return findings
}

/**
 * Findings about the T3 thread behind each claim. `probes` maps a thread id to what `t3 thread show` said:
 * `{state, activeRunId, updatedAt?}`, `{missing: true}` or `{error}`. A thread nobody probed is skipped.
 */
export function runHealth(board, probes, now = new Date()) {
  const findings = []
  const unchecked = []
  const unlinked = []
  for (const task of board.tasks) {
    if (task.status !== 'claimed') continue
    const wake = currentWake(task)
    if (!wake) {
      if (currentRun(task)?.kind === 't3_task') unlinked.push(task.id)
      continue
    }
    const probe = probes[wake.threadId]
    if (!probe) continue
    if ('error' in probe) {
      unchecked.push(task.id)
      continue
    }
    const warning = deadRunFinding(task, wake, probe, now)
    if (warning) findings.push(warning)
  }
  return [...findings, ...runSummaryFindings(unchecked, unlinked)]
}

function claimFindings(board, now) {
  const stale = staleClaims(board, { now })
  const findings = stale
    .filter((claim) => claim.ageHours !== null)
    .map((claim) => {
      const run = runLabel(claim.run)
      const runNote = run ? ` Its run is \`${run}\`; check that before releasing.` : ''
      return finding(
        'warn',
        'stale-claim',
        `task ${claim.id} (${claim.owner}) has had no sign of life for ${claim.ageHours}h; if its worker is gone, \`release ${claim.id}\`.${runNote}`,
        { id: claim.id },
      )
    })
  const untimed = stale.filter((claim) => claim.ageHours === null)
  if (untimed.length) {
    findings.push(
      finding(
        'info',
        'untimed-claims',
        `${untimed.length} claimed task(s) predate claim timestamps, so their age is unknown and nothing will reap them: ${untimed.map((claim) => claim.id).join(', ')}`,
      ),
    )
  }
  return findings
}

function heldFindings(board) {
  const held = board.tasks.filter((task) => task.status === 'open' && task.route === 'needs_lead')
  if (!held.length) return []
  return [
    finding(
      'info',
      'held-for-lead',
      `${held.length} open task(s) wait for the lead to route them: ${held.map((task) => task.id).join(', ')}`,
    ),
  ]
}

function latestRouteDecision(task) {
  if (!Array.isArray(task.decisions)) return null
  const routes = task.decisions.filter((decision) => decision && decision.kind === 'route')
  return routes.length ? routes[routes.length - 1] : null
}

function unknownRouteFinding(task) {
  if (task.route == null || KNOWN_ROUTES.includes(task.route)) return null
  return finding(
    'warn',
    'unknown-route',
    `task ${task.id} has unknown route ${JSON.stringify(task.route)}; known routes: ${KNOWN_ROUTES.join(', ')}`,
    { id: task.id },
  )
}

function verdictExplainsRoute(task) {
  if (!Array.isArray(task.decisions)) return false
  return task.decisions.some((decision) => decision?.kind === 'jev' && decision.verdict?.route === task.route)
}

function overrideFinding(task) {
  if (!task.jev || typeof task.jev !== 'object' || typeof task.jev.route !== 'string') return null
  if (task.route === task.jev.route || latestRouteDecision(task)?.to === task.route) return null
  if (verdictExplainsRoute(task)) return null
  return finding(
    'warn',
    'undocumented-override',
    `task ${task.id} route ${JSON.stringify(task.route)} is not explained by a route decision (jev route ${JSON.stringify(task.jev.route)})`,
    { id: task.id },
  )
}

function roleFitSuggestion(suggestedRole) {
  return suggestedRole ? ` Jev suggested ${suggestedRole}.` : ' Jev did not suggest one.'
}

function roleMismatchFinding(task) {
  const jev = task.jev
  // An adopted suggestion leaves roleFits false on a task that now has the suggested role.
  if (!jev || jev.roleFits !== false || jev.suggestedRole === task.role) return null
  return finding(
    'warn',
    'role-mismatch',
    `task ${task.id} role ${task.role} does not fit.${roleFitSuggestion(jev.suggestedRole)}`,
    { id: task.id },
  )
}

function activeJournalFindings(board) {
  const findings = []
  for (const task of board.tasks) {
    if (task.status !== 'open' && task.status !== 'claimed') continue
    for (const item of [unknownRouteFinding(task), overrideFinding(task), roleMismatchFinding(task)]) {
      if (item) findings.push(item)
    }
  }
  return findings
}

function healPreviewFindings(board) {
  const residue = board.tasks
    .filter((task) => hasClaimResidue(task) || staleRun(task) || staleWake(task))
    .map((task) => task.id)
  const dupes = board.tasks.filter(
    (task) => stringEvidence(task) && uniqueStrings(task.evidence).length !== task.evidence.length,
  )
  const findings = []
  if (residue.length)
    findings.push(
      finding(
        'info',
        'claim-residue',
        `the next write will clear leftover claim fields or drop a stale run on task(s): ${residue.join(', ')}`,
        { fixable: true },
      ),
    )
  if (dupes.length)
    findings.push(
      finding(
        'info',
        'duplicate-evidence',
        `the next write will dedupe evidence on task(s): ${dupes.map((task) => task.id).join(', ')}`,
        { fixable: true },
      ),
    )
  return findings
}

function undeliveredFindings(task, now) {
  return (task.deliveries ?? [])
    .filter(
      (record) =>
        record.state === 'failed' ||
        record.state === 'unaddressed' ||
        (record.state === 'pending' && now.getTime() - Date.parse(record.nextAttemptAt) > 300000),
    )
    .map((record) =>
      finding('warn', 'undelivered-message', `task ${task.id} delivery ${record.id} is ${record.state}`, {
        id: task.id,
      }),
    )
}

/** @param {any} board */
function tagLeadFindings(board) {
  const tags = board.tagLeadWakes
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return []
  return Object.entries(tags).flatMap(([tag, wake]) => {
    const thread = readThreadId(wake?.threadId)
    if (!thread) return []
    return [
      finding(
        'info',
        'tag-lead-wake',
        `tag ${tag} lead address is ${thread}; a task with this tag uses it when that task has no lead address of its own`,
      ),
    ]
  })
}

function journalFindings(board, now = new Date()) {
  const findings = activeJournalFindings(board)
  if (!board.leadWake?.threadId)
    findings.push(finding('warn', 'no-lead-wake', 'board has no lead address; run `lead-wake <threadId> --by <lead>`'))
  findings.push(...tagLeadFindings(board))
  for (const task of board.tasks) {
    findings.push(...undeliveredFindings(task, now))
    if (task.status === 'claimed' && task.route !== 'lead_workflow' && !currentWake(task))
      findings.push(
        finding(
          'warn',
          'unaddressed-claim',
          `task ${task.id} has no current wake address; run \`heartbeat ${task.id} --owner ${task.owner} --wake <threadId>\``,
          { id: task.id },
        ),
      )
  }
  const unlinked = board.tasks.filter((task) => task.status === 'claimed' && !runLabel(currentRun(task)))
  if (unlinked.length)
    findings.push(
      finding(
        'info',
        'claim-without-run',
        `${unlinked.length} claimed task(s) have no run link: ${unlinked.map((task) => task.id).join(', ')}`,
      ),
    )
  findings.push(...healPreviewFindings(board))
  return findings
}

function boardSizeFinding(file) {
  if (!existsSync(file)) return []
  const size = statSync(file).size
  if (size <= BOARD_SIZE_BYTES) return []
  return [
    {
      level: 'info',
      code: 'board-size',
      message: `board file is ${size} bytes, over 300 KB; run \`archive --older-than-days 7\``,
    },
  ]
}

function archiveFindings(file) {
  let torn
  try {
    torn = tornArchiveBytes(archivePath(file))
  } catch (error) {
    return [{ level: 'error', code: 'archive-unreadable', message: error.message }]
  }
  if (!torn) return []
  const message = `the archive ends in a torn line (${torn} bytes, a crash mid-append); the next \`archive\` run cuts it`
  return [{ level: 'warn', code: 'torn-archive', message }]
}

/** Findings about the board's files: a lock, temp files, readability. Read-only. */
export function inspectFiles(file, { now = Date.now() } = {}) {
  const findings = [...boardSizeFinding(file), ...archiveFindings(file)]
  const lock = lockState(`${file}.lock`, now)
  if (lock.held && lock.stale)
    findings.push({
      level: 'warn',
      code: 'stale-lock',
      message: `the board lock is stale (${lock.reason}); any mutating command (or doctor --fix) clears it`,
      fixable: true,
    })
  for (const path of orphanTmpFiles(file, now))
    findings.push({ level: 'warn', code: 'orphan-tmp', message: `orphaned temp file ${basename(path)}`, fixable: true })
  try {
    readBoardFile(file, { repair: false })
  } catch (error) {
    findings.push({
      level: 'error',
      code: 'unreadable-board',
      message: error.message,
      fixable: existsSync(`${file}.bak`),
    })
  }
  return findings
}

/** The one repair that needs a decision: a claim with no owner is open work again. */
export function reopenOwnerlessClaims(board) {
  const reopened = []
  for (const task of board.tasks) {
    if (task.status !== 'claimed' || task.owner) continue
    task.status = 'open'
    task.owner = null
    clearClaimResidue(task)
    reopened.push(task.id)
  }
  if (reopened.length) healEvents.push(`reopened claimed task(s) that had no owner: ${reopened.join(', ')}`)
  return reopened
}
