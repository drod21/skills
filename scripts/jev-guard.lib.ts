// What may leave the machine on a Jev call. route, decide, and ask all use this.
import { cleanText as checkText, secretFileReason as secretFileName, secretShape } from './text-guard.mjs'

// Whole uppercase name segments, so npm's lowercase npm_package_*_url values and words like MONKEY never match.
// A URL that carries a password is refused by its shape in text-guard.mjs, whatever variable holds it.
const SECRET_ENV_NAME = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|DSN|DATABASE_URL)(_|$)/
const MIN_SECRET_CHARS = 12

/**
 * Refuses a request that carries the API key, or the value of any secret-named environment variable
 * (a KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, DSN, or DATABASE_URL name segment). The error names the variable,
 * never the value.
 */
export function assertApiKeyAbsent(request: unknown) {
  const sent = JSON.stringify(request)
  const key = process.env.TYPESAFE_API_KEY?.trim()
  if (key && sent.includes(key)) throw new Error('input contains the API key; remove it')
  for (const [name, raw] of Object.entries(process.env)) {
    const value = raw?.trim()
    if (!value || value.length < MIN_SECRET_CHARS || !SECRET_ENV_NAME.test(name)) continue
    if (sent.includes(value)) throw new Error(`input contains the value of ${name}; remove it`)
  }
}

/** The message with the API key replaced, so a failure never prints it. */
export function redactApiKey(message: string) {
  const key = process.env.TYPESAFE_API_KEY?.trim()
  return key ? message.split(key).join('[redacted]') : message
}

/** Checks text bound for Jev: no binary or image data, number dumps, or email addresses. Returns it trimmed. */
export const cleanText: (value: unknown, field: string, allowEmpty?: boolean, maxChars?: number) => string = checkText

/** Keeps the end of a log. A short string is returned unchanged. */
export function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(text.length - maxChars)
}

/** Why a file must not be read for Jev, or null. Checked on the name before any bytes are read. */
export const secretFileReason: (name: string) => string | null = secretFileName

/** What kind of credential `text` seems to hold, or null. */
export const secretInText: (text: string) => string | null = secretShape
