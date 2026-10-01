import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleStrava, type StravaAccount, type StravaTokens, type TokenStore } from './strava'

const env = { STRAVA_CLIENT_ID: '123', STRAVA_CLIENT_SECRET: 'shh' }
const NOW = 1_800_000_000_000

/** In-memory tokens for one user, 'u1', whose Supabase token is 'jwt-u1'. */
class MemoryStore implements TokenStore {
  tokens = new Map<string, StravaTokens>()
  accounts = new Map<string, StravaAccount>()
  lease = false
  async userFor(jwt: string) {
    return jwt === 'jwt-u1' ? 'u1' : null
  }
  async get(userId: string) {
    return this.tokens.get(userId) ?? null
  }
  async save(userId: string, tokens: StravaTokens, account?: StravaAccount) {
    this.tokens.set(userId, tokens)
    this.lease = false
    if (account) this.accounts.set(userId, account)
  }
  async claimRefresh() {
    if (this.lease) return false
    this.lease = true
    return true
  }
  async releaseRefresh() {
    this.lease = false
  }
  async remove(userId: string) {
    this.tokens.delete(userId)
    this.accounts.delete(userId)
  }
}

let store: MemoryStore

function post(action: string, body: unknown, headers: Record<string, string> = { authorization: 'Bearer jwt-u1' }) {
  return new Request(`http://localhost:5173/api/strava/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function upstream(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

const sent = (fetchImpl: ReturnType<typeof upstream>, call = 0) => {
  const [url, init] = fetchImpl.mock.calls[call] as unknown as [string, RequestInit]
  return { url, params: Object.fromEntries(init.body as URLSearchParams) }
}

const call = (action: string, body: unknown, fetchImpl: typeof fetch, headers?: Record<string, string>) =>
  handleStrava(action, post(action, body, headers), env, { fetch: fetchImpl, store, now: () => NOW, sleep: async () => {} })

beforeEach(() => {
  store = new MemoryStore()
})

describe('handleStrava', () => {
  it('exchanges a code, keeps the tokens, and returns only the athlete', async () => {
    const fetchImpl = upstream(200, { access_token: 'a', refresh_token: 'r', expires_at: 1, athlete: { id: 9, firstname: 'Jo' } })
    const res = await call('exchange', { code: 'c0de', scope: 'read,activity:read_all' }, fetchImpl)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ athleteId: 9, athleteName: 'Jo', scope: 'read,activity:read_all' })
    expect(JSON.stringify(body)).not.toMatch(/"a"|"r"/)
    expect(sent(fetchImpl)).toEqual({
      url: 'https://www.strava.com/oauth/token',
      params: { client_id: '123', client_secret: 'shh', code: 'c0de', grant_type: 'authorization_code' },
    })
    expect(store.tokens.get('u1')).toEqual({ access_token: 'a', refresh_token: 'r', expires_at: 1 })
    expect(store.accounts.get('u1')).toEqual({ athlete_id: 9, athlete_name: 'Jo', scope: 'read,activity:read_all' })
  })

  it('returns a current access token without calling Strava', async () => {
    store.tokens.set('u1', { access_token: 'a', refresh_token: 'r', expires_at: NOW / 1000 + 3600 })
    const fetchImpl = upstream(200, {})
    const res = await call('token', {}, fetchImpl)
    expect(await res.json()).toEqual({ access_token: 'a', expires_at: NOW / 1000 + 3600 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refreshes an expiring token and keeps the rotated refresh token', async () => {
    store.tokens.set('u1', { access_token: 'a', refresh_token: 'r', expires_at: NOW / 1000 + 10 })
    const fetchImpl = upstream(200, { access_token: 'b', refresh_token: 'r2', expires_at: NOW / 1000 + 21600 })
    const res = await call('token', {}, fetchImpl)
    expect(await res.json()).toMatchObject({ access_token: 'b' })
    expect(sent(fetchImpl).params).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r' })
    expect(store.tokens.get('u1')?.refresh_token).toBe('r2')
  })

  it('refreshes once when requests race, and the others wait for the new token', async () => {
    store.tokens.set('u1', { access_token: 'a', refresh_token: 'r', expires_at: NOW / 1000 - 10 })
    let finish!: () => void
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((r) => (finish = r))
      return new Response(JSON.stringify({ access_token: 'b', refresh_token: 'r2', expires_at: NOW / 1000 + 21600 }))
    })
    const sleep = async () => {
      finish?.()
      await new Promise((r) => setTimeout(r, 0))
    }
    const deps = { fetch: fetchImpl, store, now: () => NOW, sleep }
    const [first, second] = await Promise.all([
      handleStrava('token', post('token', {}), env, deps),
      handleStrava('token', post('token', {}), env, deps),
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await first.json()).toMatchObject({ access_token: 'b' })
    expect(await second.json()).toMatchObject({ access_token: 'b' })
  })

  it("doesn't wait for another refresh while the current token still works", async () => {
    store.tokens.set('u1', { access_token: 'a', refresh_token: 'r', expires_at: NOW / 1000 + 120 })
    store.lease = true
    const sleep = vi.fn(async () => {})
    const fetchImpl = upstream(200, {})
    const res = await handleStrava('token', post('token', {}), env, { fetch: fetchImpl, store, now: () => NOW, sleep })
    expect(await res.json()).toMatchObject({ access_token: 'a' })
    expect(sleep).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads the tokens again after taking the lease, and skips the refresh if another request just did it', async () => {
    store.tokens.set('u1', { access_token: 'a', refresh_token: 'r', expires_at: NOW / 1000 + 10 })
    const claim = store.claimRefresh.bind(store)
    // Another instance refreshed between this request's first read and its claim.
    store.claimRefresh = async () => {
      store.tokens.set('u1', { access_token: 'b', refresh_token: 'r2', expires_at: NOW / 1000 + 21600 })
      return claim()
    }
    const fetchImpl = upstream(400, {})
    const res = await call('token', {}, fetchImpl)
    expect(await res.json()).toMatchObject({ access_token: 'b' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.lease).toBe(false)
  })

  it("doesn't disconnect on a rejected refresh when the refresh token has changed meanwhile", async () => {
    store.tokens.set('u1', { access_token: 'a', refresh_token: 'r', expires_at: 0 })
    const fetchImpl = vi.fn(async () => {
      // Another instance, whose lease this one outlived, rotated the token first.
      store.tokens.set('u1', { access_token: 'b', refresh_token: 'r2', expires_at: NOW / 1000 + 21600 })
      return new Response('{}', { status: 400 })
    })
    const res = await call('token', {}, fetchImpl)
    expect(await res.json()).toMatchObject({ access_token: 'b' })
    expect(store.tokens.get('u1')?.refresh_token).toBe('r2')
  })

  it('retries saving the rotated tokens once', async () => {
    store.tokens.set('u1', { access_token: 'a', refresh_token: 'r', expires_at: 0 })
    const save = store.save.bind(store)
    let failures = 1
    store.save = async (...args) => {
      if (failures-- > 0) throw new Error('database unreachable')
      return save(...args)
    }
    const res = await call('token', {}, upstream(200, { access_token: 'b', refresh_token: 'r2', expires_at: NOW / 1000 + 21600 }))
    expect(res.status).toBe(200)
    expect(store.tokens.get('u1')?.refresh_token).toBe('r2')
  })

  it('reports a revoked refresh token so the app can ask to reconnect', async () => {
    store.tokens.set('u1', { access_token: 'a', refresh_token: 'r', expires_at: 0 })
    const res = await call('token', {}, upstream(400, { message: 'Bad Request' }))
    expect(res.status).toBe(410)
    expect(store.lease).toBe(false)
    expect(store.tokens.size).toBe(0)
  })

  it('revokes with the stored token and forgets it', async () => {
    store.tokens.set('u1', { access_token: 'a', refresh_token: 'r', expires_at: 0 })
    store.accounts.set('u1', { athlete_id: 9, athlete_name: '', scope: '' })
    const fetchImpl = upstream(200, {})
    expect((await call('revoke', {}, fetchImpl)).status).toBe(200)
    expect(sent(fetchImpl)).toEqual({ url: 'https://www.strava.com/oauth/deauthorize', params: { access_token: 'a' } })
    expect(store.tokens.size + store.accounts.size).toBe(0)
  })

  it('needs a signed-in caller', async () => {
    const fetchImpl = upstream(200, {})
    expect((await call('token', {}, fetchImpl, {})).status).toBe(401)
    expect((await call('token', {}, fetchImpl, { authorization: 'Bearer forged' })).status).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects missing config, bad input and unknown actions', async () => {
    const fetchImpl = upstream(200, {})
    const deps = { fetch: fetchImpl, store }
    expect((await handleStrava('token', post('token', {}), {}, deps)).status).toBe(500)
    expect((await handleStrava('token', post('token', {}), env, { fetch: fetchImpl })).status).toBe(500)
    expect((await call('exchange', {}, fetchImpl)).status).toBe(400)
    expect((await call('nope', {}, fetchImpl)).status).toBe(404)
    expect((await call('token', {}, fetchImpl)).status).toBe(410) // not connected
    const get = new Request('http://localhost:5173/api/strava/token')
    expect((await handleStrava('token', get, env, deps)).status).toBe(405)
  })

  it('reports Strava being unreachable', async () => {
    store.tokens.set('u1', { access_token: 'a', refresh_token: 'r', expires_at: 0 })
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    expect((await call('token', {}, fetchImpl)).status).toBe(502)
    expect(store.lease).toBe(false)
  })
})
