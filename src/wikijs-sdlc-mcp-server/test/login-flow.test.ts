import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { WikiJsLoginFlow } from '../src/oauth/login-flow.js'
import { EncryptedFileStore } from '../src/oauth/store.js'
import { WikiJsOAuth } from '../src/oauth/wikijs-oauth.js'

const resource = new URL('http://sdlc-mcp.localhost/mcp')
const callback = new URL('http://localhost/oauth/wikijs/login/callback')
const wikiCallback = new URL('http://localhost/oauth/wikijs/callback')

async function fixture() {
  const pair = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const issuer = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/sdlc`)
  const path = join(await mkdtemp(join(tmpdir(), 'wikijs-login-')), 'grants.enc')
  let now = 1_000_000
  let challenge = ''
  let nonce = ''
  let badNonce = false
  const wikiJs = new WikiJsOAuth({
    wikiOrigin: new URL('http://wiki.localhost'), redirectUrl: wikiCallback, scopes: 'mcp:read pages:read',
    store: new EncryptedFileStore(path, randomBytes(32)), now: () => now,
    fetch: async (input) => {
      if (new URL(String(input)).pathname === '/_oauth/register') return Response.json({ client_id: 'wiki-client' }, { status: 201 })
      return Response.json({ access_token: 'wiki-token', refresh_token: 'refresh', expires_in: 3600 })
    }
  })
  const flow = new WikiJsLoginFlow({
    issuer, resource, clientId: 'wiki-login-client', callbackUrl: callback, wikiJs, now: () => now,
    fetch: async (_input, init) => {
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get('client_id'), 'wiki-login-client')
      assert.equal(body.get('redirect_uri'), callback.toString())
      assert.equal(createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url'), challenge)
      const idToken = await new SignJWT({ nonce: badNonce ? 'wrong' : nonce }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(issuer.toString()).setAudience('wiki-login-client').setSubject('alice').setExpirationTime('5m').sign(pair.privateKey)
      return Response.json({ id_token: idToken })
    }
  })
  const original = new URL(`${issuer}/protocol/openid-connect/auth`)
  original.search = new URLSearchParams({ client_id: 'https://vscode.dev/oauth/client-metadata.json', redirect_uri: 'http://127.0.0.1:33418/', response_type: 'code', resource: resource.toString(), state: 'original', code_challenge: 'client-challenge', code_challenge_method: 'S256' }).toString()
  async function begin() {
    const start = await flow.start(new Request(original))
    assert.equal(start.status, 302)
    const browser = flow.startBrowser(new Request(start.headers.get('location')!))
    assert.equal(browser.status, 302)
    const authorize = new URL(browser.headers.get('location')!)
    challenge = authorize.searchParams.get('code_challenge')!
    nonce = authorize.searchParams.get('nonce')!
    return { cookie: browser.headers.get('set-cookie')!.split(';')[0]!, state: authorize.searchParams.get('state')! }
  }
  return { flow, wikiJs, original, begin, close: () => server.close(), expire: () => { now += 11 * 60 * 1000 }, invalidateNonce: () => { badNonce = true } }
}

test('initial Wiki.js sign-in obtains a user grant then resumes the original CIMD request', async () => {
  const f = await fixture()
  try {
    const { state, cookie } = await f.begin()
    const kc = await f.flow.callback(new Request(`${callback}?code=keycloak-code&state=${state}`, { headers: { cookie } }))
    const start = await f.wikiJs.handleStart(new URL(kc.headers.get('location')!))
    const wikiCookie = start.headers.get('set-cookie')!.split(';')[0]!
    const authorize = new URL(start.headers.get('location')!)
    assert.equal(authorize.pathname, '/_oauth/authorize')
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(authorize.searchParams.get('resource'), 'http://wiki.localhost/_mcp')
    const providerCallback = new Request(`${wikiCallback}?code=wiki-code&state=${authorize.searchParams.get('state')}`, { headers: { cookie: `${cookie}; ${wikiCookie}` } })
    const result = f.flow.finishProvider(providerCallback, await f.wikiJs.handleCallback(providerCallback))
    assert.equal(result.status, 302)
    assert.equal(new URL(result.headers.get('location')!).search, f.original.search)
    assert.equal(await f.wikiJs.accessToken('alice'), 'wiki-token')
    assert.equal(await f.wikiJs.accessToken('bob'), undefined)
    const again = await f.begin()
    const existing = await f.flow.callback(new Request(`${callback}?code=keycloak-code&state=${again.state}`, { headers: { cookie: again.cookie } }))
    assert.equal(new URL(existing.headers.get('location')!).search, f.original.search)
  } finally { f.close() }
})

test('Wiki.js login rejects wrong browsers, replay, expiry, bad identity and denial', async () => {
  const f = await fixture()
  try {
    const wrong = await f.begin()
    assert.equal((await f.flow.callback(new Request(`${callback}?code=x&state=${wrong.state}`, { headers: { cookie: 'wikijs_mcp_login=wrong' } }))).status, 400)
    assert.equal((await f.flow.callback(new Request(`${callback}?code=x&state=${wrong.state}`, { headers: { cookie: wrong.cookie } }))).status, 400)
    const expired = await f.begin()
    f.expire()
    assert.equal((await f.flow.callback(new Request(`${callback}?code=x&state=${expired.state}`, { headers: { cookie: expired.cookie } }))).status, 400)
    const denied = await f.begin()
    const kc = await f.flow.callback(new Request(`${callback}?code=x&state=${denied.state}`, { headers: { cookie: denied.cookie } }))
    const start = await f.wikiJs.handleStart(new URL(kc.headers.get('location')!))
    const wikiCookie = start.headers.get('set-cookie')!.split(';')[0]!
    const authorize = new URL(start.headers.get('location')!)
    const providerCallback = new Request(`${wikiCallback}?error=access_denied&state=${authorize.searchParams.get('state')}`, { headers: { cookie: `${denied.cookie}; ${wikiCookie}` } })
    const result = f.flow.finishProvider(providerCallback, await f.wikiJs.handleCallback(providerCallback))
    assert.equal(result.status, 403)
    assert.equal(await f.wikiJs.isConnected('alice'), false)
    const bad = await f.begin()
    f.invalidateNonce()
    assert.equal((await f.flow.callback(new Request(`${callback}?code=x&state=${bad.state}`, { headers: { cookie: bad.cookie } }))).status, 502)
    const other = new URL(f.original)
    other.searchParams.set('resource', 'http://forgejo-mcp.localhost/mcp')
    assert.equal((await f.flow.start(new Request(other))).status, 400)
    const silent = new URL(f.original)
    silent.searchParams.set('prompt', 'none')
    assert.equal(new URL((await f.flow.start(new Request(silent))).headers.get('location')!).search, silent.search)
  } finally { f.close() }
})
