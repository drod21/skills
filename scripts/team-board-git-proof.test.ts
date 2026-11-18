import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { verifyGitProof } from './board-git-proof.mjs'
import { main as ask } from './jev-ask.ts'

it('gates mechanical and mixed tasks on a verified squash tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-git-proof-'))
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main')
    const commit = (value: string) => {
      writeFileSync(join(dir, 'file'), value)
      git('add', 'file')
      git('-c', 'user.name=Verifier', '-c', 'user.email=proof@example.test', 'commit', '-qm', value)
      return git('rev-parse', 'HEAD')
    }
    const base = commit('base')
    git('switch', '-qc', 'candidate')
    const candidate = commit('reviewed result')
    git('switch', '-q', 'main')
    const landed = commit('squash lost a change')
    git('switch', '-qc', 'landed-good', base)
    const good = commit('reviewed result')
    const plan = join(dir, 'plan.json')
    const script = join(import.meta.dirname, 'team-tasks.mjs')
    const env = { ...process.env, TEAM_TASKS_FILE: join(dir, 'tasks.json') }
    const board = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' })
    const ok = (...args: string[]) => {
      const result = board(...args)
      expect(result.status, result.stderr).toBe(0)
    }
    writeFileSync(plan, JSON.stringify({ repo: dir, candidate, base, landed, target: 'refs/heads/main' }))
    ok('add', 'qa-worker', 'Verify proposed squash', '--git-proof', plan)
    ok('claim', 'qa-worker', 'qa', '--id', '1')
    expect(board('verify-git', '1', '--by', 'qa').stderr).toContain('tree differs')
    expect(board('done', '1', '--owner', 'qa').stderr).toContain('NeverDoneWithoutGitProof')

    writeFileSync(plan, JSON.stringify({ repo: dir, candidate, base, landed: good, target: 'refs/heads/landed-good' }))
    ok('add', 'qa-worker', 'Verify landed squash', '--git-proof', plan)
    ok('claim', 'qa-worker', 'qa', '--id', '2')
    ok('verify-git', '2', '--by', 'qa')
    ok('done', '2', '--owner', 'qa')

    ok('add', 'qa-worker', 'Verify landed squash and editing behavior', '--git-proof', plan, '--accept', 'Editing behavior is correct')
    ok('claim', 'qa-worker', 'qa', '--id', '3')
    ok('verify-git', '3', '--by', 'qa')
    expect(board('done', '3', '--owner', 'qa').stderr).toContain('NeverDoneUnconfirmed')
    const evidence = join(dir, 'evidence.txt')
    writeFileSync(evidence, 'Editing behavior passed on the pinned candidate.')
    ok('evidence', '3', evidence)
    const retained = JSON.parse(board('show', '3').stdout).evidence[0]
    const boardBefore = process.env.TEAM_TASKS_FILE
    process.env.TEAM_TASKS_FILE = env.TEAM_TASKS_FILE
    try {
      expect(await ask([
        '--check-evidence', '--task', '3', '--by', 'qa', '--summary', 'Behavior verified',
        '--phase', 'acceptance', '--current-evidence', retained,
      ], {
        client: { systemOne: async (request) => {
          expect(request.state.task).toMatchObject({ candidate })
          return { answers: { fits: { noul: 0.9 }, gap: {
            choice: 'fits', confidence: 0.9, probabilities: { fits: 0.9, incomplete: 0, other_check: 0, failing: 0 },
          } } }
        } },
      })).toBe(0)
    } finally {
      if (boardBefore === undefined) delete process.env.TEAM_TASKS_FILE
      else process.env.TEAM_TASKS_FILE = boardBefore
    }
    ok('done', '3', '--owner', 'qa')

    const workflowPath = '.github/workflows/test.yml'
    mkdirSync(join(dir, '.github/workflows'), { recursive: true })
    writeFileSync(join(dir, workflowPath), 'name: tests\n')
    git('add', workflowPath)
    const ciHead = commit('candidate with trusted workflow')
    const ci = { repository: 'example/proof', workflow: 4, workflowPath, workflowCommit: ciHead, run: 8, attempt: 2, job: 'test', step: 'Run tests' }
    const repository = { full_name: 'example/proof' }
    const run = { id: 8, workflow_id: 4, path: workflowPath, head_sha: ciHead, run_attempt: 2, event: 'push', repository, head_repository: repository, status: 'completed', conclusion: 'success' }
    const step = { name: 'Run tests', number: 3, status: 'completed', conclusion: 'success' }
    const job = { id: 9, run_id: 8, head_sha: ciHead, name: 'test', status: 'completed', conclusion: 'success', steps: [step] }
    const read = (path: string) => path.endsWith('/runs/8') ? run : { total_count: 1, jobs: [job] }
    expect(verifyGitProof({ repo: dir, candidate: ciHead, ci }, read)).toMatchObject({
      ci: { run: 8, attempt: 2, jobId: 9, step: 3 },
    })
    expect(() => verifyGitProof({ repo: dir, candidate: ciHead, ci: { ...ci, attempt: 1 } }, read))
      .toThrow('successful pinned workflow attempt')
    run.event = 'pull_request'
    expect(() => verifyGitProof({ repo: dir, candidate: ciHead, ci }, read)).toThrow('successful pinned workflow attempt')
    run.event = 'push'
    step.conclusion = 'skipped'
    expect(() => verifyGitProof({ repo: dir, candidate: ciHead, ci }, read)).toThrow('successful matching workflow step')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
