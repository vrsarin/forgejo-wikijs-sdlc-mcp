import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { ProviderOAuth } from '../../../src/providers/forgejo/provider-oauth.js'
import { KeycloakLoginFlow } from '../../../src/core/login-flow.js'
import { definition } from '../../../src/providers/forgejo/definition.js'
import { EncryptedFileStore } from '../../../src/core/encrypted-file-store.js'

const resource = new URL('http://forgejo-mcp.localhost/mcp')
const callbackUrl = new URL('http://localhost/oauth/forgejo/login/callback')
const forgejoCallback = new URL('http://localhost/oauth/forgejo/callback')

async function fixture() {
  const pair = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const issuer = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/sdlc`)
  const path = join(await mkdtemp(join(tmpdir(), 'forgejo-login-')), 'grants.enc')
  let now = 1_000_000
  let expectedChallenge = ''
  let nonce = ''
  let subject = 'alice'
  let tokenNonce: string | undefined
  const provider = new ProviderOAuth({
    publicUrl: new URL('http://git.localhost'), internalUrl: new URL('http://forgejo:3000'), redirectUrl: forgejoCallback,
    clientId: 'forgejo-app', clientSecret: 'secret', store: new EncryptedFileStore(path, randomBytes(32)),
    now: () => now,
    fetch: async (_input, init) => {
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get('client_id'), 'forgejo-app')
      return Response.json({ access_token: 'alice-forgejo-token', refresh_token: 'refresh', expires_in: 3600 })
    }
  })
  const flow = new KeycloakLoginFlow(definition, {
    issuer, resource, clientId: 'link-client', callbackUrl, provider, now: () => now,
    fetch: async (_input, init) => {
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get('client_id'), 'link-client')
      assert.equal(body.get('redirect_uri'), callbackUrl.toString())
      assert.equal(createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url'), expectedChallenge)
      const idToken = await new SignJWT({ nonce: tokenNonce ?? nonce }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(issuer.toString()).setAudience('link-client').setSubject(subject).setExpirationTime('5m').sign(pair.privateKey)
      return Response.json({ id_token: idToken })
    }
  })
  const original = new URL(`${issuer}/protocol/openid-connect/auth`)
  original.search = new URLSearchParams({ client_id: 'https://vscode.dev/oauth/client-metadata.json', redirect_uri: 'http://127.0.0.1:33418/', response_type: 'code', resource: resource.toString(), state: 'original-state', code_challenge: 'client-challenge', code_challenge_method: 'S256' }).toString()
  async function begin() {
    const start = await flow.start(new Request(original))
    assert.equal(start.status, 302)
    const browser = flow.startBrowser(new Request(start.headers.get('location')!))
    assert.equal(browser.status, 302)
    const keycloak = new URL(browser.headers.get('location')!)
    assert.equal(keycloak.pathname, '/realms/sdlc/protocol/openid-connect/auth-upstream')
    expectedChallenge = keycloak.searchParams.get('code_challenge')!
    nonce = keycloak.searchParams.get('nonce')!
    return { cookie: browser.headers.get('set-cookie')!.split(';')[0]!, state: keycloak.searchParams.get('state')! }
  }
  return {
    flow, provider, original, begin,
    close: () => server.close(),
    setTime: (value: number) => { now = value },
    setSubject: (value: string) => { subject = value },
    setTokenNonce: (value: string) => { tokenNonce = value }
  }
}

test('initial CIMD sign-in connects Forgejo then resumes the unchanged Keycloak request', async () => {
  const f = await fixture()
  try {
    const { state, cookie } = await f.begin()
    const kc = await f.flow.callback(new Request(`${callbackUrl}?code=keycloak-code&state=${state}`, { headers: { cookie } }))
    assert.equal(kc.status, 302)
    const forgejoStart = new URL(kc.headers.get('location')!)
    const start = await f.provider.handleStart(forgejoStart)
    const forgejoCookie = start.headers.get('set-cookie')!.split(';')[0]!
    const authorize = new URL(start.headers.get('location')!)
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
    const providerCallback = new Request(`${forgejoCallback}?code=forgejo-code&state=${authorize.searchParams.get('state')}`, { headers: { cookie: `${cookie}; ${forgejoCookie}` } })
    const resumed = f.flow.finishProvider(providerCallback, await f.provider.handleCallback(providerCallback))
    assert.equal(resumed.status, 302)
    const location = new URL(resumed.headers.get('location')!)
    assert.equal(location.pathname, '/realms/sdlc/protocol/openid-connect/auth-upstream')
    assert.equal(location.search, f.original.search)
    assert.equal(await f.provider.accessToken('alice'), 'alice-forgejo-token')
    assert.equal(await f.provider.accessToken('bob'), undefined)

    const again = await f.begin()
    const connected = await f.flow.callback(new Request(`${callbackUrl}?code=keycloak-code&state=${again.state}`, { headers: { cookie: again.cookie } }))
    assert.equal(new URL(connected.headers.get('location')!).search, f.original.search)
  } finally { f.close() }
})

test('the login flow rejects wrong browsers, replay, expiry, invalid identity and other resources', async () => {
  const f = await fixture()
  try {
    const first = await f.begin()
    assert.equal((await f.flow.callback(new Request(`${callbackUrl}?code=x&state=${first.state}`, { headers: { cookie: 'forgejo_mcp_login=wrong' } }))).status, 400)
    assert.equal((await f.flow.callback(new Request(`${callbackUrl}?code=x&state=${first.state}`, { headers: { cookie: first.cookie } }))).status, 400)
    const expired = await f.begin()
    f.setTime(1_000_000 + 11 * 60 * 1000)
    assert.equal((await f.flow.callback(new Request(`${callbackUrl}?code=x&state=${expired.state}`, { headers: { cookie: expired.cookie } }))).status, 400)
    const invalid = await f.begin()
    f.setTokenNonce('wrong')
    assert.equal((await f.flow.callback(new Request(`${callbackUrl}?code=x&state=${invalid.state}`, { headers: { cookie: invalid.cookie } }))).status, 502)
    assert.equal(await f.provider.isConnected('alice'), false)
    const other = new URL(f.original)
    other.searchParams.set('resource', 'http://sdlc-mcp.localhost/mcp')
    assert.equal((await f.flow.start(new Request(other))).status, 400)
    other.searchParams.append('resource', resource.toString())
    assert.equal((await f.flow.start(new Request(other))).status, 400)
    const silent = new URL(f.original)
    silent.searchParams.set('prompt', 'none')
    const passthrough = await f.flow.start(new Request(silent))
    assert.equal(new URL(passthrough.headers.get('location')!).search, silent.search)
    assert.equal(passthrough.headers.get('set-cookie'), null)
  } finally { f.close() }
})

test('declining Forgejo consent never resumes the original MCP login', async () => {
  const f = await fixture()
  try {
    const { state, cookie } = await f.begin()
    const login = await f.flow.callback(new Request(`${callbackUrl}?code=keycloak-code&state=${state}`, { headers: { cookie } }))
    const start = await f.provider.handleStart(new URL(login.headers.get('location')!))
    const forgejoCookie = start.headers.get('set-cookie')!.split(';')[0]!
    const authorize = new URL(start.headers.get('location')!)
    const denied = new Request(`${forgejoCallback}?error=access_denied&state=${authorize.searchParams.get('state')}`, { headers: { cookie: `${cookie}; ${forgejoCookie}` } })
    const result = f.flow.finishProvider(denied, await f.provider.handleCallback(denied))
    assert.equal(result.status, 403)
    assert.equal(result.headers.get('location'), null)
    assert.equal(await f.provider.isConnected('alice'), false)
  } finally { f.close() }
})
