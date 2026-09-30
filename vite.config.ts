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
  return {
    plugins: [react(), stravaTokenRoutes(env)],
  }
})
