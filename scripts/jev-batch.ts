import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { TypeSafeClient, type Questions, type SystemOneRequest } from '@typesafe-ai/sdk'
import { type } from 'arktype'

import { buildAskRequest, hashRequest, readAsk, type AskOutcome } from './jev-ask.lib.ts'
import { assertApiKeyAbsent, cleanText, redactApiKey, secretFileReason, secretInText } from './jev-guard.lib.ts'

const text = type('0 < string <= 12000')
const id = type('string').matching(/^[a-z][a-z0-9_]{0,47}$/)
const ask = type({ kind: "'yes_no'", question: '0 < string <= 300' }).or({
  kind: "'pick'",
  question: '0 < string <= 300',
  labels: { '[string]': '0 < string <= 300' },
})
export const batchSchema = type({
  context: text,
  items: type({ id, context: 'string <= 6000', ask }).array().atLeastLength(1).atMostLength(1000),
})
export type BatchInput = typeof batchSchema.infer
export type JevClient = { systemOne: (request: SystemOneRequest<Questions>) => PromiseLike<{ answers: unknown }> }
export type BatchResult = { id: string; receipt: string; requestHash: string; result: AskOutcome }
const cellsSchema = type({ '[string]': 'unknown' })
const MAX_REQUEST_CHARS = 24000
const MAX_QUESTIONS = 24

export function readJevInput<T>(file: string, parse: (value: unknown) => T): T {
  const refusal = secretFileReason(basename(file))
  if (refusal) throw new Error(refusal)
  return parse(JSON.parse(readFileSync(file, 'utf8')))
}

export function validateJevText(value: string, name: string) {
  const secret = secretInText(value)
  if (secret) throw new Error(`${name} looks like it contains ${secret}`)
  cleanText(value, name, true, 1000000)
}

function validateBatchContent(input: BatchInput) {
  const seen = new Set<string>()
  validateJevText(input.context, 'context')
  for (const item of input.items) {
    if (seen.has(item.id)) throw new Error(`duplicate question id ${item.id}`)
    seen.add(item.id)
    validateJevText(item.context, item.id)
    validateJevText(item.ask.question, 'question')
    if (item.ask.kind === 'pick') {
      const labels = Object.keys(item.ask.labels)
      if (labels.length < 2 || labels.length > 4 || labels.some((label) => !/^[a-z][a-z0-9_]{0,31}$/.test(label)))
        throw new Error('pick needs two to four identifier labels')
      for (const value of Object.values(item.ask.labels)) validateJevText(value, 'label')
    }
  }
}

export function batchRequests(input: BatchInput) {
  validateBatchContent(input)
  const chunks: BatchInput['items'][] = []
  let chunk: BatchInput['items'] = []
  for (const item of input.items) {
    const next = [...chunk, item]
    if (next.length > MAX_QUESTIONS || JSON.stringify(requestFor(input.context, next)).length > MAX_REQUEST_CHARS) {
      if (chunk.length) chunks.push(chunk)
      chunk = [item]
    } else chunk = next
    if (JSON.stringify(requestFor(input.context, chunk)).length > MAX_REQUEST_CHARS)
      throw new Error(`question ${item.id} exceeds the request budget; split its context`)
  }
  if (chunk.length) chunks.push(chunk)
  return chunks.map((items) => ({ items, request: requestFor(input.context, items) }))
}

function requestFor(context: string, items: BatchInput['items']): SystemOneRequest<Questions> {
  const questions: Questions = {}
  for (const item of items) {
    const question = `Judge only item ${item.id} in items against the shared context. ${item.ask.question}`
    const built = buildAskRequest({ ...item.ask, question }, { context: '', images: [] })
    questions[item.id] = Object.values(built.questions)[0]!
  }
  return { state: { context, items: items.map(({ id, context }) => ({ id, context })) }, questions }
}

function hold(reason: string): AskOutcome {
  return { outcome: 'hold', answer: null, p: null, confidence: null, reasons: [reason] }
}

export async function runBatch(
  raw: unknown,
  out: string,
  client: JevClient = new TypeSafeClient({ defaultModel: 'jev-latest' }),
): Promise<BatchResult[]> {
  const input = batchSchema.assert(raw)
  const chunks = batchRequests(input)
  for (const { request } of chunks) assertApiKeyAbsent(request)
  mkdirSync(out, { recursive: true })
  const results: BatchResult[] = []
  for (const { items, request } of chunks) {
    const requestHash = hashRequest(request)
    const receipt = join(resolve(out), `batch-${requestHash}-${randomUUID()}.json`)
    let answers: Record<string, unknown> = {}
    let error: string | null = null
    try {
      const response = await client.systemOne(request)
      answers = cellsSchema.assert(response.answers)
    } catch (cause) {
      error = redactApiKey(cause instanceof Error ? cause.message : String(cause))
    }
    const chunkResults = items.map((item) => {
      const key = item.ask.kind === 'yes_no' ? 'answer' : 'pick'
      const result = error ? hold(`unavailable: ${error}`) : readAsk(item.ask, { [key]: answers[item.id] })
      return { id: item.id, receipt, requestHash, result }
    })
    writeFileSync(receipt, JSON.stringify({ request, answers, error, results: chunkResults }, null, 2), { flag: 'wx' })
    results.push(...chunkResults)
  }
  return results
}

export async function batchMain(argv = process.argv.slice(2), client?: JevClient) {
  const [file, flag, out] = argv
  if (!file || flag !== '--out' || !out || argv.length !== 3)
    throw new Error('usage: node scripts/jev-batch.ts input.json --out artifact-directory')
  const input = readJevInput(file, batchSchema.assert)
  const results = await runBatch(input, out, client)
  console.log(
    JSON.stringify({ outcome: results.some((r) => r.result.outcome === 'hold') ? 'hold' : 'answered', results }),
  )
  return results.some((r) => r.result.outcome === 'hold') ? 3 : 0
}

export function launchJevCli(moduleUrl: string, main: () => Promise<number>) {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(resolve(process.argv[1])).href) return
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(redactApiKey(error instanceof Error ? error.message : String(error)))
      process.exitCode = 1
    })
}

launchJevCli(import.meta.url, batchMain)
