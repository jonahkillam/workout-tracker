import { describe, expect, it, vi } from 'vitest'
import { handleStrava } from './strava'

const env = { STRAVA_CLIENT_ID: '123', STRAVA_CLIENT_SECRET: 'shh' }

function post(action: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:5173/api/strava/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function upstream(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

describe('handleStrava', () => {
  it('exchanges a code with the client secret and passes the tokens back', async () => {
    const fetchImpl = upstream(200, { access_token: 'a', refresh_token: 'r', expires_at: 1, athlete: { id: 9 } })
    const res = await handleStrava('exchange', post('exchange', { code: 'c0de' }), env, fetchImpl)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ access_token: 'a', athlete: { id: 9 } })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://www.strava.com/oauth/token')
    const sent = Object.fromEntries(init.body as URLSearchParams)
    expect(sent).toEqual({ client_id: '123', client_secret: 'shh', code: 'c0de', grant_type: 'authorization_code' })
  })

  it('refreshes with the refresh token', async () => {
    const fetchImpl = upstream(200, { access_token: 'b' })
    await handleStrava('refresh', post('refresh', { refresh_token: 'r' }), env, fetchImpl)
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(Object.fromEntries(init.body as URLSearchParams)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r' })
  })

  it('passes Strava errors through', async () => {
    const res = await handleStrava('exchange', post('exchange', { code: 'bad' }), env, upstream(400, { message: 'Bad Request' }))
    expect(res.status).toBe(400)
  })

  it('rejects missing config, cross-origin calls, bad input and unknown actions', async () => {
    const fetchImpl = upstream(200, {})
    expect((await handleStrava('exchange', post('exchange', { code: 'c' }), {}, fetchImpl)).status).toBe(500)
    const cross = post('exchange', { code: 'c' }, { origin: 'https://evil.example' })
    expect((await handleStrava('exchange', cross, env, fetchImpl)).status).toBe(403)
    const same = post('exchange', { code: 'c' }, { origin: 'http://localhost:5173' })
    expect((await handleStrava('exchange', same, env, fetchImpl)).status).toBe(200)
    expect((await handleStrava('exchange', post('exchange', {}), env, fetchImpl)).status).toBe(400)
    expect((await handleStrava('nope', post('nope', {}), env, fetchImpl)).status).toBe(404)
    const get = new Request('http://localhost:5173/api/strava/exchange')
    expect((await handleStrava('exchange', get, env, fetchImpl)).status).toBe(405)
  })

  it('reports Strava being unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    expect((await handleStrava('refresh', post('refresh', { refresh_token: 'r' }), env, fetchImpl)).status).toBe(502)
  })
})
