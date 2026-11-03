import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { HomeAssistantOAuth } from './homeassistant-oauth.mjs'

const issuer = 'http://auth.localhost/realms/sdlc'
const hash = (subject) => createHash('sha256').update(`${issuer}.${subject}`).digest('hex')
const store = () => {
  const state = { grants: {} }
  return { state, load: async () => state, save: async (next) => { state.grants = { ...next.grants } } }
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function fixture({ identity = hash('user-1'), provider = 'auth_oidc', now = () => 0 } = {}) {
  const stored = store()
  const requests = []
  const oauth = new HomeAssistantOAuth({
    publicUrl: 'https://home.localhost/', internalUrl: 'https://home-assistant-upstream-tls/',
    callbackUrl: 'http://localhost/oauth/homeassistant/callback', issuer, store: stored, now,
    fetch: async (url, options) => {
      requests.push({ path: new URL(url).pathname, options })
      if (new URL(url).pathname === '/auth/token') {
        return json({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 300, ha_auth_provider: provider })
      }
      if (new URL(url).pathname === '/api/sdlc-mcp/identity') return json({ oidc_subject_hashes: [identity] })
      if (new URL(url).pathname === '/auth/revoke') return new Response(null, { status: 200 })
      throw new Error('Unexpected request')
    }
  })
  return { oauth, stored, requests }
}

function start(oauth, subject = 'user-1') {
  const link = oauth.beginConnect(subject)
  const state = new URL(link).searchParams.get('state')
  const started = oauth.handleStart(new URL(link))
  const cookie = started.headers.get('set-cookie').split(';')[0]
  return { state, started, cookie }
}

test('rejects an unencrypted Home Assistant OAuth upstream', () => {
  assert.throws(() => new HomeAssistantOAuth({
    publicUrl: 'https://home.localhost/', internalUrl: 'http://home-assistant:8123/',
    callbackUrl: 'http://localhost/oauth/homeassistant/callback', issuer, store: store()
  }), /Invalid local Home Assistant OAuth endpoint/)
})

test('PKCE connection binds the Home Assistant grant to the verified Keycloak subject', async () => {
  const { oauth, stored } = fixture()
  const { state, started, cookie } = start(oauth)
  const auth = new URL(started.headers.get('location'))
  assert.equal(auth.pathname, '/auth/authorize')
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(auth.searchParams.get('state'), state)
  const response = await oauth.handleCallback(new Request(`http://localhost/oauth/homeassistant/callback?state=${state}&code=code`, { headers: { cookie } }))
  assert.equal(response.status, 200)
  assert.equal(await oauth.accessToken('user-1'), 'access-token')
  assert.equal(await oauth.accessToken('user-2'), undefined)
  assert.deepEqual(Object.keys(stored.state.grants), ['user-1'])
  assert.equal((await oauth.handleCallback(new Request(`http://localhost/oauth/homeassistant/callback?state=${state}&code=code`, { headers: { cookie } }))).status, 400)
})

test('wrong browser and different or local Home Assistant identity cannot create a grant', async () => {
  for (const options of [{ identity: hash('other') }, { provider: 'homeassistant' }]) {
    const { oauth, stored } = fixture(options)
    const { state, cookie } = start(oauth)
    const response = await oauth.handleCallback(new Request(`http://localhost/oauth/homeassistant/callback?state=${state}&code=code`, { headers: { cookie } }))
    assert.equal(response.status, 502)
    assert.deepEqual(stored.state.grants, {})
  }
  const { oauth, stored } = fixture()
  const { state } = start(oauth)
  assert.equal((await oauth.handleCallback(new Request(`http://localhost/oauth/homeassistant/callback?state=${state}&code=code`))).status, 400)
  assert.deepEqual(stored.state.grants, {})
})

test('expired grants refresh once and remain bound to the same user', async () => {
  let time = 0
  const { oauth, requests } = fixture({ now: () => time })
  const { state, cookie } = start(oauth)
  assert.equal((await oauth.handleCallback(new Request(`http://localhost/oauth/homeassistant/callback?state=${state}&code=code`, { headers: { cookie } }))).status, 200)
  time = 250_000
  assert.deepEqual(await Promise.all([oauth.accessToken('user-1'), oauth.accessToken('user-1')]), ['access-token', 'access-token'])
  assert.equal(requests.filter((entry) => entry.path === '/auth/token').length, 2)
  assert.equal(await oauth.disconnect('user-1'), true)
  assert.equal(await oauth.accessToken('user-1'), undefined)
  assert.equal(requests.filter((entry) => entry.path === '/auth/revoke').length, 1)
})

test('a failed store write revokes the new grant without reporting a connection', async () => {
  const state = { grants: {} }
  const revoked = []
  const oauth = new HomeAssistantOAuth({
    publicUrl: 'https://home.localhost/', internalUrl: 'https://home-assistant-upstream-tls/',
    callbackUrl: 'http://localhost/oauth/homeassistant/callback', issuer,
    store: { load: async () => state, save: async () => { throw new Error('disk error') } },
    fetch: async (url) => {
      const path = new URL(url).pathname
      if (path === '/auth/token') return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 300, ha_auth_provider: 'auth_oidc' })
      if (path === '/api/sdlc-mcp/identity') return json({ oidc_subject_hashes: [hash('user-1')] })
      if (path === '/auth/revoke') { revoked.push(true); return new Response(null, { status: 200 }) }
      throw new Error('Unexpected request')
    }
  })
  const { state: requestState, cookie } = start(oauth)
  const result = await oauth.handleCallback(new Request(`http://localhost/oauth/homeassistant/callback?state=${requestState}&code=code`, { headers: { cookie } }))
  assert.equal(result.status, 502)
  assert.equal(await oauth.isConnected('user-1'), false)
  assert.equal(revoked.length, 1)
})

test('failed remote revocation preserves the stored grant', async () => {
  const state = { grants: { 'user-1': { accessToken: 'access', refreshToken: 'refresh', expiresAt: 300_000, scope: '' } } }
  const oauth = new HomeAssistantOAuth({
    publicUrl: 'https://home.localhost/', internalUrl: 'https://home-assistant-upstream-tls/',
    callbackUrl: 'http://localhost/oauth/homeassistant/callback', issuer,
    store: { load: async () => state, save: async () => {} },
    fetch: async () => new Response(null, { status: 500 })
  })
  await assert.rejects(() => oauth.disconnect('user-1'), /revocation failed/)
  assert.equal(await oauth.isConnected('user-1'), true)
})
