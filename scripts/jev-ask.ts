import './jev-node-only.mjs'
import { resolveBoardFile } from './team-board-path.mjs'
// A cheap Jev judgment: yes/no, a small pick, a preset, or the evidence check.
// Usage: node scripts/jev-ask.ts --yes-no <q> [--task <id> --by <owner>] [--context <text>]
//        node scripts/jev-ask.ts --pick a,b[,c,d] --question <q> [--task <id> --by <owner>]
//        node scripts/jev-ask.ts --preset flaky_or_real|blocker_or_nit|clipped_text [--task <id> --by <owner>]
//        node scripts/jev-ask.ts --check-evidence --summary <text> --task <id> --by <owner>
//          [--phase <checkpoint> --current-evidence <retained-path> ...]
// --out <dir> writes a receipt and does not touch the board. --task records a judgment.
// Stdout is one JSON line. Exit 0 answered/confirmed, 2 rejected, 3 hold, 1 refused or Jev down.
// Run under Node 22.18+, not Bun.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { image, TypeSafeClient } from '@typesafe-ai/sdk'

import {
  ASK_THRESHOLDS,
  PRESETS,
  buildAskRequest,
  buildCheckRequest,
  hashRequest,
  readAsk,
  readCheck,
  receiptPath,
  toJudgment,
  type Ask,
  type AskOutcome,
  type CheckOutcome,
  type EvidenceItem,
  type ReferencedEvidence,
} from './jev-ask.lib.ts'
import {
  assertApiKeyAbsent,
  cleanText,
  redactApiKey,
  secretFileReason,
  secretInText,
  tailText,
} from './jev-guard.lib.ts'

const USAGE =
  'usage: node scripts/jev-ask.ts (--yes-no <q> | --pick a,b[,c,d] --question <q> | --preset flaky_or_real|blocker_or_nit|clipped_text | --check-evidence [--preflight] --summary <text> [--phase <checkpoint> --current-evidence <retained-path> ...]) [--context <text> | --context-file <path>] [--image <png|jpg>] [--task <id> --by <owner> | --out <dir>]'

const LABEL = /^[a-z][a-z0-9_]{0,31}$/
const CONTEXT_TAIL = 3000
const TEXT_TAIL = 4000
const MAX_IMAGES = 4
const MAX_EVIDENCE_ITEMS = 12
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
// Each side TypeSafe accepts, inclusive. The documented area bounds are these
// squares, so a side check is the area check. https://docs.typesafe.ai/images
const IMAGE_SIDE_PX = { min: 280, max: 1568 } as const
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

type BoardExec = (script: string, args: string[]) => string
type Client = {
  systemOne: (
    request: Parameters<TypeSafeClient['systemOne']>[0],
    options?: Parameters<TypeSafeClient['systemOne']>[1],
  ) => PromiseLike<{ answers: unknown; model?: string }>
}
type Mode = 'yes_no' | 'pick' | 'preset' | 'check'

type AskArgs = {
  mode: Mode
  preflight: boolean
  question: string
  labels: Record<string, string>
  preset?: keyof typeof PRESETS
  summary: string
  phase?: string
  currentEvidence: string[]
  context?: string
  contextFile?: string
  images: string[]
  task?: string
  by?: string
  out?: string
}

type Prepared = {
  args: AskArgs
  ask: Ask | null
  request: ReturnType<typeof buildCheckRequest>
  requestHash: string
  receipt: string
  tool: 'ask' | 'check'
  question: string
  evidence: string[]
  basis: number
  taskTitle: string
  hasImage: boolean
  accept: string
  seen: string[]
}

const scriptDir = dirname(fileURLToPath(import.meta.url))

function flagValue(argv: string[], index: number, name: string) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value\n${USAGE}`)
  return value
}

const VALUE_FLAGS = new Set([
  '--yes-no',
  '--pick',
  '--question',
  '--preset',
  '--summary',
  '--phase',
  '--context',
  '--context-file',
  '--task',
  '--by',
  '--out',
])

function takeValues(argv: string[]) {
  const values: Record<string, string> = {}
  const images: string[] = []
  const currentEvidence: string[] = []
  let check = false
  let preflight = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    if (arg === '--check-evidence') check = true
    else if (arg === '--preflight') preflight = true
    else if (arg === '--image') images.push(flagValue(argv, ++index, arg))
    else if (arg === '--current-evidence') currentEvidence.push(flagValue(argv, ++index, arg))
    else if (VALUE_FLAGS.has(arg)) values[arg] = flagValue(argv, ++index, arg)
    else throw new Error(`unexpected argument ${arg}\n${USAGE}`)
  }
  return { values, images, check, currentEvidence, preflight }
}

function parseLabels(raw: string) {
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  if (ids.length < 2 || ids.length > 4) throw new Error('--pick needs 2 to 4 labels')
  const labels: Record<string, string> = {}
  for (const id of ids) {
    if (!LABEL.test(id)) throw new Error(`--pick label ${JSON.stringify(id)} must match ${LABEL}`)
    if (Object.hasOwn(labels, id)) throw new Error(`--pick label ${id} is duplicated`)
    labels[id] = id
  }
  return labels
}

function oneMode(check: boolean, values: Record<string, string>): Mode {
  const modes = [
    values['--yes-no'] !== undefined,
    values['--pick'] !== undefined,
    values['--preset'] !== undefined,
    check,
  ]
  if (modes.filter(Boolean).length !== 1)
    throw new Error(`pass exactly one of --yes-no, --pick, --preset, --check-evidence\n${USAGE}`)
  if (values['--yes-no'] !== undefined) return 'yes_no'
  if (values['--pick'] !== undefined) return 'pick'
  if (values['--preset'] !== undefined) return 'preset'
  return 'check'
}

function assertRecording(values: Record<string, string>) {
  const task = values['--task']
  const by = values['--by']
  if (task && !/^[1-9]\d*$/.test(task)) throw new Error('--task needs a positive integer task id')
  if (task && !by) throw new Error('--task needs --by <owner>')
  if (by && !task) throw new Error('--by needs --task <id>')
  if (values['--out'] && task) throw new Error('pass --task or --out, not both')
  if (by) refuseJevBy(by)
}

function refuseJevBy(by: string) {
  const plain = by
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Mn}]/gu, '')
    .trim()
    .toLowerCase()
  if (plain === 'jev') throw new Error('by jev is reserved for verdicts')
}

function assertModeArgs(mode: Mode, values: Record<string, string>) {
  if (values['--context'] !== undefined && values['--context-file'] !== undefined)
    throw new Error('pass --context or --context-file, not both')
  if (mode === 'pick' && !values['--question']) throw new Error('--pick needs --question <text>')
  if (mode === 'check' && !values['--summary']) throw new Error('--check-evidence needs --summary <text>')
  if (mode === 'check' && !values['--task']) throw new Error('--check-evidence needs --task <id>')
}

function presetOf(values: Record<string, string>) {
  const preset = values['--preset']
  if (preset !== undefined && !Object.hasOwn(PRESETS, preset))
    throw new Error(`--preset must be one of ${Object.keys(PRESETS).join(', ')}`)
  return preset
}

export function parseAskArgs(argv: string[]): AskArgs {
  const { values, images, check, currentEvidence, preflight } = takeValues(argv)
  const mode = oneMode(check, values)
  if (preflight && mode !== 'check') throw new Error('--preflight requires --check-evidence')
  assertRecording(values)
  assertModeArgs(mode, values)
  const phase = checkPhase(mode, values['--phase'], currentEvidence)
  const preset = presetOf(values)
  const question = boundedQuestion(mode === 'yes_no' ? values['--yes-no'] : values['--question'])
  return {
    mode,
    preflight,
    question: question ?? '',
    labels: values['--pick'] ? parseLabels(values['--pick']) : {},
    ...(preset && Object.hasOwn(PRESETS, preset) ? { preset: preset as keyof typeof PRESETS } : {}),
    summary: values['--summary'] ?? '',
    phase,
    currentEvidence: [...new Set(currentEvidence)],
    ...(values['--context'] !== undefined ? { context: values['--context'] } : {}),
    ...(values['--context-file'] !== undefined ? { contextFile: values['--context-file'] } : {}),
    images,
    ...(values['--task'] ? { task: values['--task'] } : {}),
    ...(values['--by'] ? { by: values['--by'] } : {}),
    ...(values['--out'] ? { out: values['--out'] } : {}),
  }
}

function checkPhase(mode: Mode, phase: string | undefined, currentEvidence: string[]) {
  if (phase === undefined && !currentEvidence.length) return undefined
  if (mode !== 'check') throw new Error('--phase and --current-evidence are check-only')
  if (!phase?.trim() || !currentEvidence.length)
    throw new Error('supply a nonempty --phase and --current-evidence together')
  return phase
}

function boundedQuestion(question: string | undefined) {
  if (question === undefined) return undefined
  const trimmed = question.trim()
  if (!trimmed) throw new Error('question must not be empty')
  if (trimmed.length > 300) throw new Error('question must be at most 300 characters')
  return trimmed
}

// The whole text is checked for credentials before the tail is cut, so a key split by the cut is still caught.
function guardedTail(text: string, field: string, maxChars: number) {
  const secret = secretInText(text)
  if (secret) throw new Error(`${field} looks like it contains ${secret}; remove it`)
  return cleanText(tailText(text, maxChars), field, true)
}

function loadContext(args: AskArgs) {
  if (args.contextFile) {
    const refused = secretFileReason(basename(args.contextFile))
    if (refused) throw new Error(`--context-file ${basename(args.contextFile)} ${refused}`)
    return guardedTail(readFileSync(args.contextFile, 'utf8'), 'context', CONTEXT_TAIL)
  }
  if (args.context !== undefined) return guardedTail(args.context, 'context', CONTEXT_TAIL)
  return ''
}

function imageKind(bytes: Uint8Array) {
  if (bytes.length >= PNG.length && PNG.every((byte, index) => bytes[index] === byte)) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  return null
}

type PixelSize = { width: number; height: number }

function u16be(bytes: Uint8Array, offset: number) {
  const hi = bytes[offset]
  const lo = bytes[offset + 1]
  if (hi === undefined || lo === undefined) return null
  return (hi << 8) | lo
}

function u32be(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length) return null
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
}

function pngSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 24) return null
  const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0)
  if (type !== 'IHDR') return null
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  if (width === null || height === null || width === 0 || height === 0) return null
  return { width, height }
}

function nextMarker(bytes: Uint8Array, offset: number) {
  if (bytes[offset] !== 0xff) return null
  let index = offset
  while (index < bytes.length && bytes[index] === 0xff) index += 1
  const code = bytes[index]
  if (code === undefined || code === 0x00) return null
  return { code, at: index + 1 }
}

function segmentLength(bytes: Uint8Array, offset: number) {
  const length = u16be(bytes, offset)
  if (length === null || length < 2 || offset + length > bytes.length) return null
  return length
}

function sofSize(bytes: Uint8Array, offset: number, length: number): PixelSize | null {
  if (length < 7) return null
  const height = u16be(bytes, offset + 3)
  const width = u16be(bytes, offset + 5)
  if (height === null || width === null || height === 0 || width === 0) return null
  return { width, height }
}

function hasNoPayload(code: number) {
  return code === 0x01 || (code >= 0xd0 && code <= 0xd7)
}

// SOF is the stored pixel size. The API strips EXIF and does not rotate.
function jpegSize(bytes: Uint8Array): PixelSize | null {
  let offset = 2
  while (offset < bytes.length) {
    const marker = nextMarker(bytes, offset)
    if (!marker) return null
    if (marker.code === 0xd9 || marker.code === 0xda) return null
    if (hasNoPayload(marker.code)) {
      offset = marker.at
      continue
    }
    const length = segmentLength(bytes, marker.at)
    if (length === null) return null
    if (SOF_MARKERS.has(marker.code)) return sofSize(bytes, marker.at, length)
    offset = marker.at + length
  }
  return null
}

function imageSideRefusal(size: PixelSize) {
  const { min, max } = IMAGE_SIDE_PX
  const oversized = size.width > max || size.height > max
  const undersized = size.width < min || size.height < min
  if (!oversized && !undersized) return null
  const resize = oversized ? ` Resize with sips -Z ${max}.` : ''
  return `image is ${size.width}x${size.height}; each side must be ${min} to ${max} pixels.${resize}`
}

function imageTransmissionWhy(bytes: Uint8Array, kind: 'png' | 'jpeg') {
  const size = kind === 'png' ? pngSize(bytes) : jpegSize(bytes)
  if (!size) return 'image dimensions could not be read'
  return imageSideRefusal(size)
}

function loadImage(path: string) {
  const bytes = readFileSync(path)
  const name = basename(path)
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`${name} is over 5 MB`)
  const kind = imageKind(bytes)
  if (!kind) throw new Error(`${name} is not a PNG or JPEG`)
  const why = imageTransmissionWhy(bytes, kind)
  if (why) throw new Error(`${name}: ${why}`)
  return image(bytes)
}

function loadImages(paths: string[]) {
  if (paths.length > MAX_IMAGES) throw new Error('--image allows at most 4 images')
  return paths.map(loadImage)
}

function fileBytes(path: string) {
  try {
    if (!statSync(path).isFile()) return null
    return readFileSync(path)
  } catch {
    return null
  }
}

function textExcerpt(name: string, bytes: Buffer): EvidenceItem {
  if (bytes.includes(0)) return { name, sent: false, why: 'not text or a png/jpeg image' }
  try {
    return { name, excerpt: guardedTail(bytes.toString('utf8'), name, TEXT_TAIL) }
  } catch (error) {
    const why = error instanceof Error ? error.message : 'text check failed'
    return { name, sent: false, why }
  }
}

function loadOne(item: string): EvidenceItem {
  const name = basename(item)
  const refused = secretFileReason(name)
  if (refused) return { name, sent: false, why: refused }
  const bytes = fileBytes(item)
  if (!bytes) return { name, sent: false, why: 'not a readable file' }
  const kind = imageKind(bytes)
  if (!kind) return textExcerpt(name, bytes)
  if (bytes.length > MAX_IMAGE_BYTES) return { name, sent: false, why: 'image is over 5 MB' }
  const why = imageTransmissionWhy(bytes, kind)
  if (why) return { name, sent: false, why }
  return { name, image: image(bytes) }
}

// At most MAX_EVIDENCE_ITEMS items and MAX_IMAGES images go out; the rest are listed as not sent.
async function loadEvidence(items: string[], current: string[]): Promise<ReferencedEvidence[]> {
  const missing = current.findIndex((ref) => !items.includes(ref))
  if (missing !== -1)
    throw new Error(`--current-evidence must match a retained task evidence path exactly (selection ${missing + 1})`)
  const selected = current.length ? items.filter((item) => current.includes(item)) : items
  let images = 0
  return selected.map((item, index) => {
    let loaded: EvidenceItem =
      index >= MAX_EVIDENCE_ITEMS
        ? { name: basename(item), sent: false, why: 'over the evidence item cap' }
        : loadOne(item)
    if ('image' in loaded && ++images > MAX_IMAGES)
      loaded = { name: loaded.name, sent: false, why: 'over the image cap' }
    if (current.includes(item) && 'sent' in loaded)
      throw new Error(`selected current evidence cannot be transmitted (selection ${current.indexOf(item) + 1}): ${loaded.why}`)
    if (current.length) cleanText(item, 'evidence reference')
    return { ...loaded, ref: item }
  })
}

function defaultExec(script: string, args: string[]) {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', env: process.env })
}

function showTask(exec: BoardExec, script: string, id: string) {
  const task = JSON.parse(exec(script, ['show', id])) as ShownTask
  if (!task || task.id !== Number(id)) throw new Error(`task ${id} does not exist`)
  return task
}

function evidenceList(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return []
  return value as string[]
}

// The board refuses a judgment on a gated task that is unclaimed or claimed by someone else; refuse it here,
// before paying for the call.
function assertClaimed(task: ShownTask | null, by: string | undefined) {
  if (!task?.accept) return
  if (task.status !== 'claimed')
    throw new Error(`task ${task.id} is ${task.status}; a gated task needs a claim before asking Jev`)
  if (task.owner !== by) throw new Error(`task ${task.id} is claimed by ${task.owner}; --by must be the owner`)
}

function assertCheckReady(args: AskArgs, task: { accept?: string } | null, evidence: string[]) {
  if (args.mode !== 'check') return
  if (!task?.accept) throw new Error('--check-evidence needs a task with accept')
  if (!evidence.length) throw new Error('--check-evidence needs evidence')
}

function askFrom(args: AskArgs): Ask {
  if (args.mode === 'preset') return PRESETS[args.preset ?? 'flaky_or_real']
  const question = cleanText(args.question, 'question')
  if (args.mode === 'pick') return { kind: 'pick', question, labels: args.labels }
  return { kind: 'yes_no', question }
}

function journalQuestion(args: AskArgs, ask: Ask | null) {
  if (args.mode === 'preset') return args.preset ?? ''
  if (args.mode === 'check') return 'Does the attached evidence show that `task.accept` passed?'
  return ask?.question ?? args.question
}

type ShownTask = {
  id?: number
  title?: string
  accept?: string
  evidence?: unknown
  decisions?: unknown
  status?: string
  owner?: string
}

function taskTitle(task: ShownTask | null) {
  return task?.title ?? ''
}

function taskAccept(task: ShownTask | null) {
  return task?.accept ?? ''
}

function taskEvidence(task: ShownTask | null) {
  return evidenceList(task?.evidence)
}

// The journal length this run read. The board refuses the check if a release, choice, or answered question
// lands after it, so a check that ran across one of those is never taken as fresh.
function journalLength(task: ShownTask | null) {
  return Array.isArray(task?.decisions) ? task.decisions.length : 0
}

function requestFor(
  args: AskArgs,
  ask: Ask | null,
  context: string,
  images: ReturnType<typeof image>[],
  task: ShownTask | null,
  items: ReferencedEvidence[],
) {
  if (ask) return buildAskRequest(ask, { context, images })
  return buildCheckRequest(
    { title: cleanText(taskTitle(task), 'task title'), accept: cleanText(taskAccept(task), 'task accept') },
    cleanText(args.summary, 'summary'),
    items,
    args.phase !== undefined
      ? cleanText(args.phase, 'phase')
      : undefined,
  )
}

function receiptFor(args: AskArgs, board: string, tool: string, requestHash: string) {
  const name = `${tool}-${requestHash.slice(0, 16)}.json`
  if (args.out) return join(args.out, name)
  return receiptPath(board, args.task ?? 'out', tool, requestHash)
}

function hasSentImage(images: unknown[], items: EvidenceItem[]) {
  return images.length > 0 || items.some((item) => 'image' in item)
}

async function prepare(args: AskArgs, exec: BoardExec, board: string): Promise<Prepared> {
  const images = loadImages(args.images)
  const context = loadContext(args)
  const task = args.task ? showTask(exec, join(scriptDir, 'team-tasks.mjs'), args.task) : null
  const evidence = taskEvidence(task)
  assertClaimed(task, args.by)
  assertCheckReady(args, task, evidence)
  const ask = args.mode === 'check' ? null : askFrom(args)
  const items = ask ? [] : await loadEvidence(evidence, args.currentEvidence)
  const request = requestFor(args, ask, context, images, task, items)
  assertApiKeyAbsent(request)
  const requestHash = hashRequest(request)
  const tool = ask ? 'ask' : 'check'
  const receipt = receiptFor(args, board, tool, requestHash)
  return {
    args,
    ask,
    request,
    requestHash,
    receipt,
    tool,
    question: journalQuestion(args, ask),
    evidence,
    basis: journalLength(task),
    taskTitle: taskTitle(task),
    hasImage: hasSentImage(images, items),
    accept: taskAccept(task),
    seen: items.map((item) => seenLine(item, args.phase !== undefined)),
  }
}

function seenLine(item: ReferencedEvidence, scoped: boolean) {
  const role = scoped ? ' [current]' : ''
  if ('sent' in item) return `${item.ref}${role} (not sent: ${item.why})`
  return `${item.ref}${role} (${'image' in item ? 'image' : 'excerpt'})`
}

type Line = {
  outcome: string
  answer: string | null
  p: number | null
  confidence: number | null
  reasons: string[]
  requestHash: string
  receipt: string
  gap?: string | null
  cached?: boolean
}

function lineFrom(outcome: AskOutcome | CheckOutcome, prepared: Prepared): Line {
  const answer = 'answer' in outcome ? outcome.answer : outcome.gap
  const confidence = 'confidence' in outcome ? outcome.confidence : null
  const gap = 'gap' in outcome ? { gap: outcome.gap } : {}
  return {
    outcome: outcome.outcome,
    answer,
    p: outcome.p,
    confidence,
    reasons: outcome.reasons,
    requestHash: prepared.requestHash,
    receipt: prepared.receipt,
    ...gap,
  }
}

function exitFor(outcome: string, down: boolean) {
  if (down) return 1
  if (outcome === 'answered' || outcome === 'confirmed') return 0
  if (outcome === 'rejected') return 2
  if (outcome === 'hold') return 3
  return 1
}

function writeReceipt(prepared: Prepared, body: unknown) {
  if (prepared.args.out && !existsSync(prepared.args.out))
    throw new Error(`output directory does not exist: ${prepared.args.out}`)
  mkdirSync(dirname(prepared.receipt), { recursive: true })
  writeFileSync(prepared.receipt, `${JSON.stringify(body, null, 2)}\n`)
}

// A saved receipt is replayed only from its raw answers, read again with today's thresholds; its stored
// outcome is never trusted. A receipt without readable answers, or one that reads as hold, is asked again.
function cachedOutcome(prepared: Prepared): AskOutcome | CheckOutcome | null {
  if (!existsSync(prepared.receipt)) return null
  let answers: unknown
  try {
    answers = (JSON.parse(readFileSync(prepared.receipt, 'utf8')) as { answers?: unknown }).answers
  } catch {
    return null
  }
  if (!answers || typeof answers !== 'object') return null
  const outcome = outcomeFrom(prepared, answers)
  return outcome.outcome === 'hold' ? null : outcome
}

function record(prepared: Prepared, outcome: AskOutcome | CheckOutcome, answers: unknown, exec: BoardExec) {
  const meta = {
    by: prepared.args.by ?? '',
    question: prepared.question,
    requestHash: prepared.requestHash,
    receipt: prepared.receipt,
    evidence: prepared.evidence,
    basis: prepared.basis,
    ...(answers && typeof answers === 'object' ? { answers } : {}),
  }
  const payload = toJudgment(prepared.tool, outcome, meta)
  exec(join(scriptDir, 'team-tasks.mjs'), ['judgment', prepared.args.task ?? '', JSON.stringify(payload)])
}

async function callJev(prepared: Prepared, client: Client) {
  const headers = prepared.hasImage ? { headers: { 'TypeSafe-Danger-Zone-Images': 'true' } } : undefined
  const response = await client.systemOne(prepared.request, headers)
  return response
}

function outcomeFrom(prepared: Prepared, answers: unknown) {
  if (prepared.ask) return readAsk(prepared.ask, answers)
  return readCheck(answers)
}

function printLine(line: Line) {
  console.log(JSON.stringify(line))
}

async function runAsk(args: AskArgs, client: Client, exec: BoardExec): Promise<number> {
  const board = resolveBoardFile()
  const prepared = await prepare(args, exec, board)
  if (args.preflight) {
    const evidence = prepared.seen.map((line) => cleanText(line, 'evidence manifest line'))
    assertApiKeyAbsent(evidence)
    console.log(
      JSON.stringify({
        outcome: 'preflight_ready',
        accept: prepared.accept,
        evidence,
        requestHash: prepared.requestHash,
      }),
    )
    return 0
  }
  const token = prepared.tool === 'check' && args.task ? randomUUID() : null
  if (token)
    exec(join(scriptDir, 'team-tasks.mjs'), [
      'check-start',
      args.task!,
      JSON.stringify({ by: args.by, token, evidence: prepared.evidence, basis: prepared.basis }),
    ])
  let settled = false
  try {
    const cached = cachedOutcome(prepared)
    if (cached) {
      // A replay is journaled again after a choice or release may have voided it.
      if (args.task) record(prepared, cached, null, exec)
      settled = true
      printLine({ ...lineFrom(cached, prepared), cached: true })
      return exitFor(cached.outcome, false)
    }
    let response: Awaited<ReturnType<Client['systemOne']>>
    try {
      response = await callJev(prepared, client)
    } catch (error) {
      const result = finishDown(prepared, error, exec)
      settled = true
      return result
    }
    const { answers } = response
    const outcome = outcomeFrom(prepared, answers)
    const line = lineFrom(outcome, prepared)
    writeReceipt(prepared, {
      ...line,
      model: response.model ?? null,
      request: prepared.request,
      answers,
      thresholds: ASK_THRESHOLDS,
    })
    if (args.task) record(prepared, outcome, answers, exec)
    settled = true
    printLine(line)
    return exitFor(outcome.outcome, false)
  } finally {
    // Failed recording or a process crash remains blocked until release/reap.
    if (token && settled) exec(join(scriptDir, 'team-tasks.mjs'), ['check-end', args.task!, token])
    else if (token)
      exec(join(scriptDir, 'team-tasks.mjs'), [
        'check-abandon',
        args.task!,
        JSON.stringify({ by: args.by, token, basis: prepared.basis }),
      ])
  }
}

function finishDown(prepared: Prepared, error: unknown, exec: BoardExec) {
  const message = redactApiKey(error instanceof Error ? error.message : String(error))
  console.error(message)
  const outcome: AskOutcome = {
    outcome: 'hold',
    answer: null,
    p: null,
    confidence: null,
    reasons: [`unavailable: ${message}`],
  }
  const line = lineFrom(outcome, prepared)
  writeReceipt(prepared, { ...line, model: null, request: prepared.request, answers: null, thresholds: ASK_THRESHOLDS })
  if (prepared.args.task) record(prepared, outcome, null, exec)
  printLine(line)
  return 1
}

function lazyClient(): Client {
  let built: TypeSafeClient | undefined
  return {
    systemOne: (request, options) =>
      (built ??= new TypeSafeClient({ defaultModel: 'jev-latest' })).systemOne(request, options),
  }
}

export async function main(argv: string[] = process.argv.slice(2), deps: { client?: Client; exec?: BoardExec } = {}) {
  try {
    const args = parseAskArgs(argv)
    return await runAsk(args, deps.client ?? lazyClient(), deps.exec ?? defaultExec)
  } catch (error) {
    const message = redactApiKey(error instanceof Error ? error.message : String(error))
    console.log(JSON.stringify({ outcome: 'refused', error: message }))
    return 1
  }
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectRun()) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(redactApiKey(error instanceof Error ? error.message : String(error)))
      process.exitCode = 1
    })
}
