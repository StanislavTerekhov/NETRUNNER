import { rmSync } from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { electronSimple } from 'vite-plugin-electron/multi-env'
import { notBundle } from 'vite-plugin-electron/plugin'
import pkg from './package.json'

const external = Object.keys('dependencies' in pkg ? (pkg.dependencies as Record<string, string>) : {})

/** Production CSP is strict; the dev server additionally needs inline scripts and the HMR socket. */
function contentSecurityPolicy(isServe: boolean): Plugin {
  const csp = [
    "default-src 'self'",
    isServe ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    isServe ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return {
    name: 'netrunner-csp',
    transformIndexHtml: html => html.replace('%NETRUNNER_CSP%', csp),
  }
}

export default defineConfig(({ command, mode }) => {
  rmSync('dist-electron', { recursive: true, force: true })

  const isServe = command === 'serve'
  const isBuild = command === 'build'
  // The release installer ships without the UI self-test (smoke) mode; dev and test builds keep it.
  const smoke = JSON.stringify(mode !== 'release')
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG

  return {
    base: './',
    resolve: {
      alias: {
        '@': path.join(__dirname, 'src'),
      },
    },
    build: {
      chunkSizeWarningLimit: 6000,
    },
    plugins: [
      react(),
      tailwindcss(),
      contentSecurityPolicy(isServe),
      electronSimple({
        main: {
          input: 'electron/main/index.ts',
          plugins: [notBundle()],
          options: {
            define: { __NETRUNNER_SMOKE__: smoke },
            build: {
              sourcemap,
              minify: isBuild,
              outDir: 'dist-electron/main',
              rolldownOptions: { external },
            },
          },
        },
        preload: {
          input: 'electron/preload/index.ts',
          plugins: [notBundle()],
          options: {
            build: {
              sourcemap: sourcemap ? 'inline' : undefined,
              minify: isBuild,
              outDir: 'dist-electron/preload',
              rolldownOptions: {
                external,
                // Sandboxed preload scripts must be CommonJS.
                output: { format: 'cjs', entryFileNames: 'index.cjs' },
              },
            },
          },
        },
      }),
    ],
    clearScreen: false,
  }
})
