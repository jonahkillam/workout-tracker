// Strava token handling. Strava requires the client secret for the code exchange and every refresh, and its token
// endpoint sends no CORS headers, so these calls go through here. Refresh tokens rotate, so each account's tokens
// live in one place, the `strava_tokens` table, and every device asks here for a current access token. Data
// calls go straight from the browser to Strava with that token.
//
// Web-standard handlers: mounted by the Vite dev/preview server (vite.config.ts) and by the Vercel function in
// api/strava/[action].ts. Callers authenticate with their Supabase access token.
import { createClient } from '@supabase/supabase-js'

export interface StravaEnv {
  STRAVA_CLIENT_ID?: string
  STRAVA_CLIENT_SECRET?: string
  SUPABASE_URL?: string
  SUPABASE_SECRET_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

export interface StravaTokens {
  access_token: string
  refresh_token: string
  /** Epoch seconds. */
  expires_at: number
}

export interface StravaAccount {
  athlete_id: number
  athlete_name: string
  scope: string
}

/** Where tokens are kept. Supabase in the app; in memory in tests. */
export interface TokenStore {
  /** The user a Supabase access token belongs to, or null if it isn't valid. */
  userFor(jwt: string): Promise<string | null>
  get(userId: string): Promise<StravaTokens | null>
  save(userId: string, tokens: StravaTokens, account?: StravaAccount): Promise<void>
  /** Takes the refresh lease; true if this caller should refresh. */
  claimRefresh(userId: string): Promise<boolean>
  releaseRefresh(userId: string): Promise<void>
  remove(userId: string): Promise<void>
}

interface StravaDeps {
  fetch?: typeof fetch
  store?: TokenStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const TOKEN_URL = 'https://www.strava.com/oauth/token'
// Deprecated in favour of /oauth/revoke; supported until 1 June 2027.
const DEAUTHORIZE_URL = 'https://www.strava.com/oauth/deauthorize'
/** Refresh when the access token has less than this long left, in seconds. */
const REFRESH_MARGIN = 300

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function supabaseTokenStore(url: string, secretKey: string): TokenStore {
  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const check = <T>({ data, error }: { data: T; error: { message: string } | null }) => {
    if (error) throw new Error(error.message)
    return data
  }
  return {
    async userFor(jwt) {
      const { data, error } = await admin.auth.getClaims(jwt)
      return error || !data?.claims.sub ? null : data.claims.sub
    },
    async get(userId) {
      return check(
        await admin.from('strava_tokens').select('access_token, refresh_token, expires_at').eq('user_id', userId).maybeSingle(),
      )
    },
    async save(userId, tokens, account) {
      check(await admin.from('strava_tokens').upsert({ user_id: userId, ...tokens, refresh_lease_until: null }))
      if (account) check(await admin.from('strava_accounts').upsert({ user_id: userId, ...account }))
    },
    async claimRefresh(userId) {
      return check(await admin.rpc('claim_strava_refresh', { uid: userId })) === true
    },
    async releaseRefresh(userId) {
      check(await admin.from('strava_tokens').update({ refresh_lease_until: null }).eq('user_id', userId))
    },
    async remove(userId) {
      check(await admin.from('strava_tokens').delete().eq('user_id', userId))
      check(await admin.from('strava_accounts').delete().eq('user_id', userId))
    },
  }
}

async function postStrava(url: string, params: Record<string, string>, fetchImpl: typeof fetch) {
  const res = await fetchImpl(url, { method: 'POST', body: new URLSearchParams(params) })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, status: res.status, body }
}

const tokensFrom = (b: Record<string, unknown>): StravaTokens => ({
  access_token: String(b.access_token),
  refresh_token: String(b.refresh_token),
  expires_at: Number(b.expires_at),
})

/** Handles POST /api/strava/{exchange,token,revoke}. */
export async function handleStrava(action: string, req: Request, env: StravaEnv, deps: StravaDeps = {}): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  const clientId = env.STRAVA_CLIENT_ID
  const clientSecret = env.STRAVA_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return json(500, { error: 'Strava is not configured: set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET' })
  }
  const secretKey = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY
  const store = deps.store ?? (env.SUPABASE_URL && secretKey ? supabaseTokenStore(env.SUPABASE_URL, secretKey) : undefined)
  if (!store) return json(500, { error: 'Supabase is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY' })
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const jwt = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
  const userId = jwt ? await store.userFor(jwt) : null
  if (!userId) return json(401, { error: 'Sign in first' })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return json(400, { error: 'Expected a JSON body' })
  }
  const str = (k: string) => (typeof body[k] === 'string' && body[k] ? (body[k] as string) : undefined)
  const credentials = { client_id: clientId, client_secret: clientSecret }

  try {
    switch (action) {
      case 'exchange': {
        const code = str('code')
        if (!code) return json(400, { error: 'Missing code' })
        const r = await postStrava(TOKEN_URL, { ...credentials, code, grant_type: 'authorization_code' }, fetchImpl)
        if (!r.ok) return json(r.status, { error: r.body.message ?? `Strava rejected the code (${r.status})` })
        const athlete = (r.body.athlete ?? {}) as { id?: number; firstname?: string; lastname?: string }
        const account = {
          athlete_id: athlete.id ?? 0,
          athlete_name: [athlete.firstname, athlete.lastname].filter(Boolean).join(' '),
          scope: str('scope') ?? '',
        }
        await store.save(userId, tokensFrom(r.body), account)
        // The tokens stay here.
        return json(200, { athleteId: account.athlete_id, athleteName: account.athlete_name, scope: account.scope })
      }
      case 'token': {
        const secs = now() / 1000
        const fresh = (t: StravaTokens) => t.expires_at - REFRESH_MARGIN > secs
        const reply = (t: StravaTokens) => json(200, { access_token: t.access_token, expires_at: t.expires_at })
        const disconnected = () => json(410, { error: 'Strava is not connected' })
        let tokens = await store.get(userId)
        if (!tokens) return disconnected()
        if (fresh(tokens)) return reply(tokens)

        // One refresh at a time per user, across server instances: the lease (claim_strava_refresh) goes to one
        // caller until it saves the new tokens or 20 s pass.
        if (!(await store.claimRefresh(userId))) {
          // Someone else is refreshing. The current token will do if it has a minute left; otherwise wait for theirs.
          for (let i = 0; tokens.expires_at - 60 <= secs; i++) {
            if (i === 20) return json(503, { error: 'Strava token refresh is taking too long' })
            await sleep(250)
            tokens = await store.get(userId)
            if (!tokens) return disconnected()
          }
          return reply(tokens)
        }
        try {
          // Read again under the lease: another caller may have refreshed since the first read, which rotated the
          // refresh token read then.
          tokens = await store.get(userId)
          if (!tokens) return disconnected()
          if (fresh(tokens)) {
            await store.releaseRefresh(userId)
            return reply(tokens)
          }
          const used = tokens.refresh_token
          const r = await postStrava(TOKEN_URL, { ...credentials, refresh_token: used, grant_type: 'refresh_token' }, fetchImpl)
          if (!r.ok) {
            await store.releaseRefresh(userId)
            if (r.status !== 400 && r.status !== 401) return json(r.status, { error: `Strava refresh failed (${r.status})` })
            // Rejected: the athlete revoked access on Strava, unless the token was rotated by someone else meanwhile
            // (a lease that ran out). 410 tells the app to show Strava as disconnected.
            const latest = await store.get(userId)
            if (latest && latest.refresh_token !== used) return reply(latest)
            await store.remove(userId)
            return json(410, { error: 'Strava access was revoked; connect again' })
          }
          // Refresh tokens rotate: keep the newest one. The old one no longer works, so try the save twice.
          const next = tokensFrom(r.body)
          await store.save(userId, next).catch(() => store.save(userId, next))
          return reply(next)
        } catch (e) {
          await store.releaseRefresh(userId).catch(() => undefined)
          throw e
        }
      }
      case 'revoke': {
        const tokens = await store.get(userId)
        if (tokens) await postStrava(DEAUTHORIZE_URL, { access_token: tokens.access_token }, fetchImpl).catch(() => undefined)
        await store.remove(userId)
        return json(200, {})
      }
      default:
        return json(404, { error: `Unknown action "${action}"` })
    }
  } catch (e) {
    // Strava or Supabase unreachable.
    return json(502, { error: (e as Error).message })
  }
}
