import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import * as z from 'zod'

import { resolveBoardFile } from './team-board-path.mjs'

// Single catalog for roles, routes, and checks. team-tasks and jev-route both import it.

const BASE_ROLES = {
  'backend-worker': 'Server, database, and shared contracts; domain specialists own their own policy and methodology',
  'ux-worker': 'Client and web UI patches',
  'security-worker': 'Auth, validation, secrets, and access-control audits or one-file fixes',
  'perf-worker': 'Query, render, and startup checks or one-file fixes',
  'qa-worker': 'Tests and runtime verification',
  'specialist-worker': 'A domain expert whose skill the project defines; add narrower roles in team-roles.json',
  lead: 'Product or architecture decisions, and splitting work that is not ready to dispatch',
}

const ROLE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const extraRoles = z.record(z.string(), z.string())

/**
 * Extra roles from a JSON object `{ "role-name": "description" }`. A missing file adds nothing; a file that exists
 * but is not that object, or names a role that is not lowercase-hyphen, throws so a typo cannot silently drop a role.
 * @param {string | null | undefined} file
 * @returns {Record<string, string>}
 */
export function loadExtraRoles(file) {
  if (!file || !existsSync(file)) return {}
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = extraRoles.safeParse(raw)
  if (!parsed.success) throw new Error(`${file} must map role names to descriptions: ${z.prettifyError(parsed.error)}`)
  for (const [name, description] of Object.entries(parsed.data)) {
    if (!ROLE_NAME.test(name)) throw new Error(`${file}: role ${JSON.stringify(name)} must be lowercase letters, digits and hyphens`)
    if (!description.trim()) throw new Error(`${file}: role ${JSON.stringify(name)} needs a description`)
  }
  return parsed.data
}

/** TEAM_ROLES_FILE, else team-roles.json beside the board. */
export function rolesFile() {
  const override = process.env.TEAM_ROLES_FILE
  if (override && override.trim()) return override.trim()
  return join(dirname(resolveBoardFile()), 'team-roles.json')
}

/**
 * The base roles plus the project's own. A project role never replaces a base role's description.
 * @param {Record<string, string>} extra
 */
export function mergeRoles(extra) {
  return { ...BASE_ROLES, ...Object.fromEntries(Object.entries(extra).filter(([name]) => !Object.hasOwn(BASE_ROLES, name))) }
}

/** @type {Record<string, string>} */
export const ROLES = mergeRoles(loadExtraRoles(rolesFile()))

/** @type {const} */
export const CHECKS = {
  typecheck: 'Types or a compile-time contract; a typecheck is the proof',
  focused_test: 'Behavior in one module that an existing test can cover',
  runtime: 'A user-visible flow that has to be exercised in the running app',
  none: 'Nothing in the task says what would prove the change',
}

// Jev's routes (scripts/jev-route.lib.ts ROUTES). A test fails if a Jev route is missing.
export const JEV_ROUTES = /** @type {const} */ ([
  'haiku_fork',
  'luna_patch',
  'gemini_patch',
  'composer_patch',
  'grok_patch',
  'sonnet_patch',
  'sol_patch',
  'terra_patch',
  'opus_patch',
  'fable_patch',
  'deterministic_script',
  'needs_lead',
])

// The *_review, *_audit, *_design and claude_/codex_patch routes are board-only, not Jev routes. A lead picks
// their pair from the model roles table in skills/team-coordinator/references/dispatch.md.
// lead_workflow is the lead running the task through an orchestration workflow or T3 delegation.
/** @type {const} */
export const KNOWN_ROUTES = [
  ...JEV_ROUTES,
  'lead_workflow',
  'claude_patch',
  'claude_review',
  'claude_audit',
  'claude_design',
  'gemini_review',
  'gemini_audit',
  'gemini_design',
  'codex_patch',
  'codex_review',
  'codex_audit',
  'codex_design',
]

/** The board's full route list. Same array as KNOWN_ROUTES. */
export const BOARD_ROUTES = KNOWN_ROUTES

/** @type {const} */
export const JEV_CHECKS = ['typecheck', 'focused_test', 'runtime', 'none']

/** @type {const} */
export const JEV_HOLDS = ['risky', 'needs_decision']

/**
 * Why `role` cannot be added, with the fix: a team or project name is a `--tag`, not a role. The suggested tag is
 * the role's first segment (`payments-runtime-gate` -> `payments`).
 * @param {unknown} role
 * @returns {string}
 */
export function unknownRoleMessage(role) {
  const catalog = Object.keys(ROLES).join(', ')
  // `unassigned` is jev-route's default when --role is omitted and Jev was not sure enough to pick an owner.
  if (typeof role !== 'string' || !role.trim() || role === 'unassigned')
    return `no role was given; use one of: ${catalog}`
  const lead = role.split('-')[0] ?? ''
  // The placeholder fails the tag pattern, so pasting it unchanged is refused rather than stored.
  const tag = /^[a-z0-9][a-z0-9-]{0,39}$/.test(lead) && lead !== 'worker' ? lead : '<team-name>'
  return (
    `unknown role ${JSON.stringify(role)}; known roles: ${catalog}. ` +
    `Pick the catalog role that owns the work and put the team or project name in --tag (for example --tag ${tag})`
  )
}
