// Token handling for Strava OAuth. Strava requires the client secret for the code
// exchange and every refresh, and its token endpoint sends no CORS headers, so
// these calls go through here. Data calls go straight from the browser.
//
// Web-standard handlers: mounted by the Vite dev/preview server (vite.config.ts)
// and by the Vercel function in api/strava/[action].ts.

export interface StravaEnv {
  STRAVA_CLIENT_ID?: string
  STRAVA_CLIENT_SECRET?: string
}

const TOKEN_URL = 'https://www.strava.com/oauth/token'
// Deprecated in favour of /oauth/revoke; supported until 1 June 2027.
const DEAUTHORIZE_URL = 'https://www.strava.com/oauth/deauthorize'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Rejects cross-site requests: the Origin, when sent, must match the host being called. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === new URL(req.url).host
  } catch {
    return false
  }
}

async function forward(url: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetchImpl(url, { method: 'POST', body: new URLSearchParams(params) })
  } catch (e) {
    return json(502, { error: `Strava unreachable: ${(e as Error).message}` })
  }
  const text = await upstream.text()
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}

/** Handles POST /api/strava/{exchange,refresh,revoke}. */
export async function handleStrava(
  action: string,
  req: Request,
  env: StravaEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })
  if (!sameOrigin(req)) return json(403, { error: 'Cross-origin request rejected' })

  const clientId = env.STRAVA_CLIENT_ID
  const clientSecret = env.STRAVA_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return json(500, { error: 'Strava is not configured: set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET' })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return json(400, { error: 'Expected a JSON body' })
  }
  const str = (k: string) => (typeof body[k] === 'string' && body[k] ? (body[k] as string) : undefined)
  const credentials = { client_id: clientId, client_secret: clientSecret }

  switch (action) {
    case 'exchange': {
      const code = str('code')
      if (!code) return json(400, { error: 'Missing code' })
      return forward(TOKEN_URL, { ...credentials, code, grant_type: 'authorization_code' }, fetchImpl)
    }
    case 'refresh': {
      const refreshToken = str('refresh_token')
      if (!refreshToken) return json(400, { error: 'Missing refresh_token' })
      return forward(TOKEN_URL, { ...credentials, refresh_token: refreshToken, grant_type: 'refresh_token' }, fetchImpl)
    }
    case 'revoke': {
      const accessToken = str('access_token')
      if (!accessToken) return json(400, { error: 'Missing access_token' })
      return forward(DEAUTHORIZE_URL, { access_token: accessToken }, fetchImpl)
    }
    default:
      return json(404, { error: `Unknown action "${action}"` })
  }
}
