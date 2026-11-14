// Text checks for anything bound for Jev. Plain JavaScript so team-tasks.mjs can refuse bad text when a
// task is added, and the TypeScript Jev scripts reuse it through jev-guard.lib.ts.

const MAX_FIELD_CHARS = 4000
const MAX_NUMERIC_RUN = 24 // consecutive bare number tokens; a convenience check, not a privacy guarantee

function longestNumericRun(text) {
  let best = 0
  let run = 0
  for (const token of text.split(/[\s,;:()[\]{}]+/)) {
    run = /^-?\d+(\.\d+)?$/.test(token) ? run + 1 : 0
    best = Math.max(best, run)
  }
  return best
}

// Shapes of credentials that must never reach Jev. Each entry names what it found, never the value.
const SECRET_SHAPES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/, 'a Stripe-style key'],
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'an API key'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JWT'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i, 'a URL with a password'],
  [
    /\b[A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
    'a secret assignment',
  ],
]

/**
 * What kind of credential `text` seems to hold, or null.
 * @param {string} text
 * @returns {string | null}
 */
export function secretShape(text) {
  for (const [pattern, name] of SECRET_SHAPES) if (pattern.test(text)) return name
  return null
}

/**
 * Checks text bound for Jev: no credentials, binary or image data, number dumps, or email addresses.
 * Returns it trimmed.
 * @param {unknown} value
 * @param {string} field
 * @param {boolean} [allowEmpty]
 * @param {number} [maxChars]
 * @returns {string}
 */
export function cleanText(value, field, allowEmpty = false, maxChars = MAX_FIELD_CHARS) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const text = value.trim()
  if (!text && !allowEmpty) throw new Error(`${field} is empty`)
  if (text.length > maxChars) throw new Error(`${field} is over ${maxChars} characters; summarize it`)
  const secret = secretShape(text)
  if (secret) throw new Error(`${field} looks like it contains ${secret}; remove it`)
  if (/data:[a-z]+\/[\w.+-]+;base64,/i.test(text) || /[A-Za-z0-9+/]{200,}/.test(text)) {
    throw new Error(`${field} looks like embedded binary or image data`)
  }
  if (longestNumericRun(text) >= MAX_NUMERIC_RUN) {
    throw new Error(`${field} has a long run of numbers; send a summary, not keypoint or sensor data`)
  }
  if (/[\w.%+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i.test(text)) throw new Error(`${field} contains an email address`)
  return text
}
