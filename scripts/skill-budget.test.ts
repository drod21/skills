import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every agent pays for these bytes before it works, so they have ceilings.
const root = resolve(import.meta.dirname, '..')
const skills = join(root, 'skills')

const CEILINGS: Record<string, number> = {
  'team-coordinator/SKILL.md': 9_000,
  'team-coordinator/references/worker-protocol.md': 5_000,
}
const SKILL_CEILING = 10_000
const BRIEF_CEILING = 1_500
const DESCRIPTION_CEILING = 200

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return markdownFiles(path)
    return name.endsWith('.md') ? [path] : []
  })
}

const skillFiles = readdirSync(skills)
  .map((name) => join(skills, name, 'SKILL.md'))
  .filter((path) => existsSync(path))

function description(path: string) {
  const front = readFileSync(path, 'utf8').split('---')[1] ?? ''
  const line = front.split('\n').find((entry) => entry.startsWith('description:'))
  if (!line) return null
  const value = line.slice('description:'.length).trim()
  return value.startsWith('"') ? JSON.parse(value) : value
}

const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .replace(/ /g, '-')

const anchors = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => slug(line.replace(/^#+ /, '')))

describe('skill budget', () => {
  it('keeps the files every lead and worker reads under their ceilings', () => {
    const over = Object.entries(CEILINGS)
      .map(([file, max]) => ({ file, bytes: statSync(join(skills, file)).size, max }))
      .filter(({ bytes, max }) => bytes > max)
    expect(over).toEqual([])
  })

  it('keeps every brief template under the brief ceiling', () => {
    const briefs = join(skills, 'team-coordinator/references/briefs')
    const over = readdirSync(briefs)
      .map((name) => ({ file: name, bytes: statSync(join(briefs, name)).size }))
      .filter(({ bytes }) => bytes > BRIEF_CEILING)
    expect(over).toEqual([])
  })

  it('keeps every SKILL.md under the skill ceiling', () => {
    const over = skillFiles
      .map((path) => ({ file: relative(skills, path), bytes: statSync(path).size }))
      .filter(({ bytes }) => bytes > SKILL_CEILING)
    expect(over).toEqual([])
  })

  it('gives every skill a description short enough for a session skill list', () => {
    const bad = skillFiles
      .map((path) => ({ file: relative(skills, path), length: description(path)?.length ?? -1 }))
      .filter(({ length }) => length < 1 || length > DESCRIPTION_CEILING)
    expect(bad).toEqual([])
  })

  it('resolves every relative link and anchor in the skills and AGENTS.md', () => {
    const broken: string[] = []
    for (const path of [...markdownFiles(skills), join(root, 'AGENTS.md')]) {
      for (const [, link] of readFileSync(path, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(link!)) continue
        const [target, anchor] = link!.split('#')
        const file = target ? resolve(dirname(path), target) : path
        if (!existsSync(file)) broken.push(`${relative(root, path)}: ${link}`)
        else if (anchor && file.endsWith('.md') && !anchors(file).includes(anchor))
          broken.push(`${relative(root, path)}: ${link} (no such heading)`)
      }
    }
    expect(broken).toEqual([])
  })
})
