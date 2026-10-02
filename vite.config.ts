import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite'
import { handleStrava, type StravaEnv } from './server/strava.ts'

/** Serves POST /api/strava/:action from the dev and preview servers, like the Vercel function does. */
function stravaTokenRoutes(env: StravaEnv): Plugin {
  const middleware: Connect.NextHandleFunction = (req: IncomingMessage, res: ServerResponse, next) => {
    const match = /^\/api\/strava\/([a-z]+)$/.exec(req.url?.split('?')[0] ?? '')
    if (!match) return next()
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      })
      const response = await handleStrava(match[1], request, env).catch(
        (e: Error) => new Response(JSON.stringify({ error: `Strava unreachable: ${e.message}` }), { status: 502 }),
      )
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      res.end(Buffer.from(await response.arrayBuffer()))
    })
  }
  return {
    name: 'strava-token-routes',
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  }
}

/**
 * Writes /sw.js: the service worker in src/sw/sw.js, told which files make up this build's app shell. The
 * version is a hash of their contents, so the worker changes (and browsers install it) only when they do.
 */
function appShellWorker(): Plugin {
  return {
    name: 'app-shell-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const hash = createHash('sha256')
      const files: string[] = []
      for (const [name, file] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        files.push(name === 'index.html' ? '/' : `/${name}`)
        hash.update(name).update(file.type === 'chunk' ? file.code : file.source)
      }
      if (!files.includes('/')) this.error('index.html is not in the bundle, so the service worker would cache no page')
      const publicDir = new URL('./public/', import.meta.url)
      for (const name of readdirSync(publicDir).sort()) {
        if (name.startsWith('.')) continue
        files.push(`/${name}`)
        hash.update(name).update(readFileSync(new URL(name, publicDir)))
      }
      const worker = readFileSync(new URL('./src/sw/sw.js', import.meta.url), 'utf8')
      hash.update(worker)
      const version = hash.digest('hex').slice(0, 12)
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `const VERSION = ${JSON.stringify(version)}\nconst FILES = ${JSON.stringify(files)}\n${worker}`,
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // The Vercel Supabase integration names its variables without a VITE_ prefix. Expose only the URL and the
  // public key to the browser; widening envPrefix would also ship the service key.
  const supabaseUrl = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  return {
    plugins: [react(), stravaTokenRoutes(env), appShellWorker()],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl ?? ''),
      'import.meta.env.VITE_SUPABASE_KEY': JSON.stringify(supabaseKey ?? ''),
    },
  }
})
