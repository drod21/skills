// Shared Zod helpers for the boundaries the board app parses: CLI JSON, request bodies, and route params.
import * as z from 'zod'

/** A JSON string, then `schema`. Invalid JSON fails the parse. */
export function jsonParsed<T extends z.ZodType>(schema: T) {
  return z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : 'Invalid JSON',
        })
        return z.NEVER
      }
    })
    .pipe(schema)
}

/**
 * A base-10 integer string with no leading zero, parsed to a positive safe integer.
 * `0`, `-1`, and `01` fail.
 */
export const positiveIntegerText = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().refine(Number.isSafeInteger))

/** An integer string parsed into `min`..`max`, inclusive. Leading zeros fail. */
export function integerTextIn(min: number, max: number) {
  return z
    .string()
    .regex(/^-?(?:0|[1-9]\d*)$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
}
