import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const toolkit = resolve(import.meta.dirname, '..')
let project: string

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'link-skills-'))
})

afterEach(() => rmSync(project, { recursive: true, force: true }))

function install(...flags: string[]) {
  const result = spawnSync('bash', [join(toolkit, 'bin/link-skills.sh'), ...flags, project], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

it('previews replacement without changing existing skills', () => {
  const skill = join(project, '.agents/skills/ux-worker')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), 'old copy')
  expect(install()).toContain('replace')
  expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toBe('old copy')
  expect(existsSync(join(project, '.claude'))).toBe(false)
})

it('replaces stale copies and Claude directories while preserving unrelated skills', () => {
  for (const base of ['.agents', '.claude']) {
    const skill = join(project, base, 'skills/ux-worker')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), 'old copy')
    writeFileSync(join(skill, 'removed.md'), 'stale')
    mkdirSync(join(project, base, 'skills/custom'), { recursive: true })
    writeFileSync(join(project, base, 'skills/custom/SKILL.md'), 'custom')
  }
  install('--apply')
  const installed = join(project, '.agents/skills/ux-worker')
  expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(toolkit, 'skills/ux-worker/SKILL.md'), 'utf8'))
  expect(existsSync(join(installed, 'removed.md'))).toBe(false)
  expect(readlinkSync(join(project, '.claude/skills/ux-worker'))).toBe('../../.agents/skills/ux-worker')
  install('--apply')
  for (const base of ['.agents', '.claude']) {
    expect(readFileSync(join(project, base, 'skills/custom/SKILL.md'), 'utf8')).toBe('custom')
  }
})

it('replaces external and dangling links without changing their targets', () => {
  const external = join(project, 'external')
  mkdirSync(external)
  writeFileSync(join(external, 'SKILL.md'), 'external')
  mkdirSync(join(project, '.agents/skills'), { recursive: true })
  mkdirSync(join(project, '.claude/skills'), { recursive: true })
  symlinkSync(external, join(project, '.agents/skills/ux-worker'))
  symlinkSync(join(project, 'missing'), join(project, '.claude/skills/ux-worker'))
  install('--apply')
  expect(readFileSync(join(external, 'SKILL.md'), 'utf8')).toBe('external')
  expect(readlinkSync(join(project, '.claude/skills/ux-worker'))).toBe('../../.agents/skills/ux-worker')
  expect(readFileSync(join(project, '.agents/skills/ux-worker/SKILL.md'), 'utf8')).toBe(readFileSync(join(toolkit, 'skills/ux-worker/SKILL.md'), 'utf8'))
})

it('keeps copies usable when Claude shares the entire agents skills directory', () => {
  mkdirSync(join(project, '.agents/skills'), { recursive: true })
  mkdirSync(join(project, '.claude'))
  symlinkSync('../.agents/skills', join(project, '.claude/skills'))
  install('--apply')
  expect(readFileSync(join(project, '.claude/skills/ux-worker/SKILL.md'), 'utf8')).toBe(readFileSync(join(toolkit, 'skills/ux-worker/SKILL.md'), 'utf8'))
})

function check() {
  return spawnSync('bash', [join(toolkit, 'bin/link-skills.sh'), '--check', project], { encoding: 'utf8' })
}

it('--check passes on fresh copies and names each drifted, extra or missing file without writing', () => {
  install('--apply')
  const clean = check()
  expect(clean.status, clean.stdout + clean.stderr).toBe(0)
  const skill = join(project, '.agents/skills/ux-worker')
  writeFileSync(join(skill, 'SKILL.md'), 'edited copy')
  writeFileSync(join(skill, 'extra.md'), 'extra')
  rmSync(join(project, '.agents/skills/qa-worker'), { recursive: true })
  const drifted = check()
  expect(drifted.status).toBe(1)
  expect(drifted.stdout).toContain('ux-worker/SKILL.md')
  expect(drifted.stdout).toContain('ux-worker/extra.md')
  expect(drifted.stdout).toContain('qa-worker')
  expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toBe('edited copy')
  expect(existsSync(join(project, '.agents/skills/qa-worker'))).toBe(false)
})
