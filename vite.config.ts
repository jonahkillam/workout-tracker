import react from '@vitejs/plugin-react'
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

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // The Vercel Supabase integration names its variables without a VITE_ prefix. Expose only the URL and the
  // public key to the browser; widening envPrefix would also ship the service key.
  const supabaseUrl = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  return {
    plugins: [react(), stravaTokenRoutes(env)],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl ?? ''),
      'import.meta.env.VITE_SUPABASE_KEY': JSON.stringify(supabaseKey ?? ''),
    },
  }
})
