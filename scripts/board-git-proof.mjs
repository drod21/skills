import { execFileSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { realpathSync } from 'node:fs'
import { type } from 'arktype'

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const ci = type({
  '+': 'reject',
  repository: /^[A-Za-z0-9][A-Za-z0-9-]*\/(?=[A-Za-z0-9_.-]*[A-Za-z0-9])[A-Za-z0-9_.-]+$/,
  workflow: 'number.integer > 0',
  workflowPath: /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/,
  workflowCommit: oid,
  run: 'number.integer > 0',
  attempt: 'number.integer > 0',
  job: 'string > 0',
  step: 'string > 0',
  'on?': "'candidate' | 'landed'",
})
const head = { '+': 'reject', repo: 'string', candidate: oid, 'ci?': ci }
const proofSchema = type.or(
  head,
  { ...head, base: oid, landed: oid, target: /^refs\/(?:heads|remotes)\/[A-Za-z0-9._/-]+$/ },
)

export function normalizeGitProof(value) {
  const proof = proofSchema.assert(value)
  if (!isAbsolute(proof.repo)) throw new Error('Git proof needs an absolute repository root')
  if (proof.ci?.on === 'landed' && !('landed' in proof))
    throw new Error('CI proof on the landed commit needs a squash proof')
  return proof
}

function verifyGitFacts(proof) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', proof.repo, ...args], {
    env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const resolve = (selector, kind) => git('rev-parse', '--verify', '--end-of-options', `${selector}^{${kind}}`)
  if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(proof.repo))
    throw new Error('Git proof path must be the repository root')
  const candidate = resolve(proof.candidate, 'commit')
  if (candidate !== proof.candidate) throw new Error('Git proof candidate must name a commit directly')
  const tree = resolve(candidate, 'tree')
  if (proof.ci) {
    const { workflowCommit, workflowPath } = proof.ci
    const workflowBlob = (commit) => git('rev-parse', '--verify', '--end-of-options', `${commit}:${workflowPath}`)
    const trustedWorkflow = workflowBlob(workflowCommit)
    if (resolve(workflowCommit, 'commit') !== workflowCommit ||
      git('cat-file', '-t', trustedWorkflow) !== 'blob' || trustedWorkflow !== workflowBlob(candidate))
      throw new Error('Git proof candidate workflow differs from the pinned trusted workflow')
  }
  if (!('landed' in proof)) {
    if (resolve('HEAD', 'commit') !== candidate) throw new Error('Git proof checkout HEAD differs from the pinned candidate')
    return { tree }
  }
  const [landed, parent, extraParent] = git('rev-list', '--parents', '-n', '1', proof.landed).split(' ')
  if (landed !== proof.landed || parent !== proof.base || extraParent)
    throw new Error('Git proof squash commit must have the pinned base as its only parent')
  if (resolve(landed, 'tree') !== tree) throw new Error('Git proof squash tree differs from the checked candidate tree')
  const tip = resolve(proof.target, 'commit')
  git('merge-base', '--is-ancestor', proof.base, candidate)
  git('merge-base', '--is-ancestor', landed, tip)
  return { tree, tip }
}

function readActions(path, select) {
  try {
    // gh-axi keeps multiple jq values as NDJSON instead of rendering a single object as TOON.
    const output = execFileSync('gh-axi', ['api', 'GET', path, '--jq', `${select}, {}`], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split('\n')
    if (output.length !== 2 || output[1] !== '{}') throw new Error('unexpected Actions output')
    return JSON.parse(output[0])
  } catch {
    throw new Error('Git proof could not read the pinned GitHub Actions result')
  }
}

const passed = (entry) => entry?.status === 'completed' && entry.conclusion === 'success'

function verifyActionsProof(proof, read) {
  const { repository, workflow, workflowPath, run, attempt, job, step } = proof.ci
  const path = `/repos/${repository}/actions/runs/${run}`
  const revision = proof.ci.on === 'landed' ? proof.landed : proof.candidate
  const result = read(path, '{id,workflow_id,path,run_attempt,head_sha,event,head_repository:{full_name:.head_repository.full_name},repository:{full_name:.repository.full_name},status,conclusion}')
  if (result?.id !== run || result.workflow_id !== workflow || result.path !== workflowPath || result.run_attempt !== attempt ||
    result.head_sha !== revision || result.repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    result.event !== 'push' || result.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    !passed(result))
    throw new Error('Git proof needs a successful pinned workflow attempt on the candidate SHA')
  const listing = read(`${path}/attempts/${attempt}/jobs?per_page=100`,
    '{total_count,jobs:[.jobs[]|{id,run_id,head_sha,name,status,conclusion,steps:[(.steps // [])[]|{name,number,status,conclusion}]}]}')
  if (!Array.isArray(listing?.jobs) || listing.total_count !== listing.jobs.length)
    throw new Error('Git proof could not read the complete pinned workflow job list')
  const jobs = listing.jobs.filter((entry) => entry.name === job)
  if (jobs.length !== 1 || !Number.isSafeInteger(jobs[0].id) ||
    jobs[0].run_id !== run || jobs[0].head_sha !== revision || !passed(jobs[0]))
    throw new Error('Git proof needs one successful matching workflow job on the candidate SHA')
  const steps = jobs[0].steps?.filter((entry) => entry.name === step)
  if (steps?.length !== 1 || !Number.isSafeInteger(steps[0].number) || !passed(steps[0]))
    throw new Error('Git proof needs one successful matching workflow step')
  return { run, attempt, jobId: jobs[0].id, step: steps[0].number }
}

export function verifyGitProof(value, read = readActions) {
  const proof = normalizeGitProof(value)
  const facts = verifyGitFacts(proof)
  return proof.ci ? { ...facts, ci: verifyActionsProof(proof, read) } : facts
}
