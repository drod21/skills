import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitroV2Plugin } from '@tanstack/nitro-v2-vite-plugin'

/**
 * TanStack Start on a Nitro v2 `bun` preset.
 * The board listens on loopback only; `nitro/loopback.ts` refuses to start on any other bind.
 */
const preset = process.env.DEPLOY_PRESET ?? 'bun'

export default defineConfig({
  build: { target: ['chrome107', 'edge107', 'firefox104', 'safari16'] },
  resolve: { tsconfigPaths: true, noExternal: ['cookie-es', 'lucide-react'] },
  plugins: [
    tailwindcss(),
    tanstackStart({
      importProtection: {
        enabled: true,
        behavior: 'error',
        client: {
          files: [/\.server\.[cm]?tsx?$/],
          specifiers: ['node:fs', 'node:path', 'node:child_process', 'node:crypto'],
        },
      },
    }),
    viteReact(),
    nitroV2Plugin({
      preset,
      compatibilityDate: '2026-08-06',
      plugins: [fileURLToPath(new URL('./src/nitro/loopback.ts', import.meta.url))],
    }),
  ],
})
