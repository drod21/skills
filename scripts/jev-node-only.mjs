// First import of every jev entry script: @typesafe-ai/sdk 0.7.0 throws "Body already used" under Bun 1.4.4.
import { relative } from 'node:path'

if (process.versions.bun) {
  const script = process.argv[1] ? relative(process.cwd(), process.argv[1]) || process.argv[1] : '<script>'
  console.error(`Run under Node 22.18+: node ${script} …`)
  process.exit(2)
}
