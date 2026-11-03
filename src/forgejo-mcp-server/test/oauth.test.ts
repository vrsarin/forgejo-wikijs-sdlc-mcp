import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig } from '../src/config.js'
import { ForgejoOAuth } from '../src/oauth/forgejo-oauth.js'
import { EncryptedFileStore } from '../src/oauth/store.js'
import { ForgejoClient } from '../src/providers/forgejo.js'
import { createForgejoServer } from '../src/server.js'

const key = randomBytes(32)
const publicUrl = new URL('http://git.localhost')
const internalUrl = new URL('http://forgejo:3000')
const redirectUrl = new URL('http://localhost/oauth/forgejo/callback')

/** A stand-in for Forgejo's authorization server: confidential client, PKCE, single-use refresh tokens. */
function fakeForgejo() {
  const calls: string[] = []
  let issued = 0
  const codes = new Map<string, string>()
  const refreshes = new Map<string, 'live' | 'used'>()
  const mint = () => { issued += 1; refreshes.set(`r${issued}`, 'live'); return { access_token: `a${issued}`, refresh_token: `r${issued}`, expires_in: 3600, token_type: 'bearer' } }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    calls.push(url.pathname)
    const form = new URLSearchParams(String(init?.body))
    if (form.get('client_id') !== 'forgejo-client' || form.get('client_secret') !== 'shh') return Response.json({ error: 'invalid_client' }, { status: 401 })
    if (form.get('grant_type') === 'authorization_code') {
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
      if (codes.get(form.get('code') ?? '') !== challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return Response.json(mint())
    }
    const state = refreshes.get(form.get('refresh_token') ?? '')
    if (state !== 'live') return Response.json({ error: 'invalid_grant', error_description: 'used' }, { status: 400 })
    refreshes.set(form.get('refresh_token')!, 'used')
    return Response.json(mint())
  }
  return { fetch, calls, issueCode: (challenge: string) => { const code = `code-${codes.size}`; codes.set(code, challenge); return code } }
}

async function setup(now = { t: 1_000_000 }) {
  const path = join(await mkdtemp(join(tmpdir(), 'forgejo-oauth-')), 'grants.enc')
  const remote = fakeForgejo()
  const oauth = new ForgejoOAuth({ publicUrl, internalUrl, redirectUrl, clientId: 'forgejo-client', clientSecret: 'shh', store: new EncryptedFileStore(path, key), fetch: remote.fetch, now: () => now.t })
  return { oauth, remote, path, now }
}

async function connect(oauth: ForgejoOAuth, remote: ReturnType<typeof fakeForgejo>, sub: string) {
  const redirect = await oauth.handleStart(new URL(await oauth.beginConnect(sub)))
  assert.equal(redirect.status, 302)
  const authorize = new URL(redirect.headers.get('location')!)
  assert.equal(authorize.origin, 'http://git.localhost', 'the browser is sent to the public address')
  assert.equal(authorize.pathname, '/login/oauth/authorize')
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorize.searchParams.get('client_id'), 'forgejo-client')
  assert.equal(authorize.searchParams.has('client_secret'), false, 'the secret never reaches the browser')
  const cookie = redirect.headers.get('set-cookie')!.split(';')[0]!
  const code = remote.issueCode(authorize.searchParams.get('code_challenge')!)
  const state = authorize.searchParams.get('state')!
  return { cookie, state, callback: (extra = '', headers: Record<string, string> = { cookie }) => oauth.handleCallback(new Request(`http://localhost/oauth/forgejo/callback?code=${code}&state=${state}${extra}`, { headers })) }
}

test('a user connects once and then gets their own token with no paste', async () => {
  const { oauth, remote } = await setup()
  assert.equal((await (await connect(oauth, remote, 'alice')).callback()).status, 200)
  assert.equal(await oauth.accessToken('alice'), 'a1')
  assert.equal(await oauth.accessToken('bob'), undefined)
})

test('the token exchange goes to the internal address with the client secret', async () => {
  const { oauth, remote } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  assert.deepEqual(remote.calls, ['/login/oauth/access_token'])
})

test('the callback is refused from a different browser, replayed, or after expiry', async () => {
  const a = await setup()
  const flow = await connect(a.oauth, a.remote, 'alice')
  assert.equal((await flow.callback('', { cookie: 'forgejo_oauth=stolen' })).status, 400)
  assert.equal(await a.oauth.accessToken('alice'), undefined)
  assert.equal((await flow.callback()).status, 400, 'a state is single use even after a failed attempt')
  const b = await setup()
  assert.equal((await (await connect(b.oauth, b.remote, 'alice')).callback('', {})).status, 400, 'no cookie, no connection')
  const c = await setup()
  const late = await connect(c.oauth, c.remote, 'alice')
  c.now.t += 11 * 60 * 1000
  assert.equal((await late.callback()).status, 400)
})

test('a denied approval connects nothing', async () => {
  const { oauth, remote } = await setup()
  const flow = await connect(oauth, remote, 'alice')
  const response = await oauth.handleCallback(new Request(`http://localhost/oauth/forgejo/callback?error=access_denied&state=${flow.state}`, { headers: { cookie: flow.cookie } }))
  assert.equal(response.status, 403)
  assert.equal(await oauth.isConnected('alice'), false)
})

test('an expiring token is refreshed once even when requests overlap, and the rotation is kept', async () => {
  const { oauth, remote, now } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  now.t += 3600 * 1000 - 30_000
  const tokens = await Promise.all([oauth.accessToken('alice'), oauth.accessToken('alice'), oauth.accessToken('alice')])
  assert.deepEqual(new Set(tokens), new Set(['a2']))
  assert.equal(remote.calls.length, 2, 'one exchange plus exactly one refresh')
  assert.equal(await oauth.accessToken('alice'), 'a2')
})

test('a refresh token Forgejo no longer accepts means the user must connect again', async () => {
  const { oauth, remote, now } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  await remote.fetch('http://forgejo:3000/login/oauth/access_token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'forgejo-client', client_secret: 'shh' }) })
  now.t += 3600 * 1000
  assert.equal(await oauth.accessToken('alice'), undefined)
  assert.equal(await oauth.isConnected('alice'), false)
})

test('grants survive a restart and are encrypted at rest', async () => {
  const { oauth, remote, path } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  const raw = await readFile(path, 'utf8')
  for (const secret of ['alice', 'accessToken', 'refreshToken', 'shh']) assert(!raw.includes(secret), `${secret} must not appear in plaintext`)
  const restarted = new ForgejoOAuth({ publicUrl, internalUrl, redirectUrl, clientId: 'forgejo-client', clientSecret: 'shh', store: new EncryptedFileStore(path, key), fetch: remote.fetch, now: () => 1_000_000 })
  assert.equal(await restarted.accessToken('alice'), 'a1')
  await assert.rejects(() => new EncryptedFileStore(path, randomBytes(32)).load())
})

test('tools call Forgejo with the verified user\'s own grant and never another user\'s', async () => {
  const { oauth, remote } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  const seen: Array<string | null> = []
  const client = new ForgejoClient({ baseUrl: internalUrl, token: undefined, allowedRepositories: new Set(['team/project']), fetch: async (_input, init) => { seen.push(new Headers(init?.headers).get('authorization')); return Response.json([]) } })
  const tools = (createForgejoServer(client, true, true, oauth) as unknown as { _registeredTools: Record<string, { handler: (input: unknown, context: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools
  const as = (subject: string) => ({ http: { req: new Request('http://x/mcp'), authInfo: { clientId: subject, extra: { subject } } } })
  await tools.list_organizations!.handler({}, as('alice'))
  assert.deepEqual(seen, ['Bearer a1'])
  await assert.rejects(() => tools.list_organizations!.handler({}, as('bob')), /connect_forgejo/)
  await assert.rejects(() => tools.list_organizations!.handler({}, { http: { req: new Request('http://x/mcp'), authInfo: { clientId: 'static' } } }), /connect_forgejo/)
  const link = JSON.parse((await tools.connect_forgejo!.handler(as('bob') as never, undefined)).content[0]!.text)
  assert.match(link.authorizeUrl, /^http:\/\/localhost\/oauth\/forgejo\/start\?state=/)
  assert.equal(JSON.parse((await tools.connect_forgejo!.handler(as('alice') as never, undefined)).content[0]!.text).connected, true)
  assert.equal(JSON.parse((await tools.get_forgejo_connection!.handler(as('bob') as never, undefined)).content[0]!.text).forgejoConnection, 'not-connected')
  await assert.rejects(() => tools.connect_forgejo!.handler({ http: { req: new Request('http://x/mcp'), authInfo: { clientId: 'static' } } } as never, undefined), /Sign in with Keycloak/)
})

test('an explicit token header still overrides the stored grant', async () => {
  const { oauth, remote } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  const seen: Array<string | null> = []
  const client = new ForgejoClient({ baseUrl: internalUrl, token: undefined, allowedRepositories: new Set(), fetch: async (_input, init) => { seen.push(new Headers(init?.headers).get('authorization')); return Response.json([]) } })
  const tools = (createForgejoServer(client, false, true, oauth) as unknown as { _registeredTools: Record<string, { handler: (input: unknown, context: unknown) => Promise<unknown> }> })._registeredTools
  await tools.list_organizations!.handler({}, { http: { req: new Request('http://x/mcp', { headers: { 'x-forgejo-token': 'explicit' } }), authInfo: { extra: { subject: 'alice' } } } })
  assert.deepEqual(seen, ['Bearer explicit'])
})

test('OAuth configuration is validated', () => {
  const base = { FORGEJO_URL: 'http://forgejo:3000', FORGEJO_ALLOW_INSECURE_HTTP: 'true', MCP_CLIENT_TOKENS: '{"vscode":"0123456789abcdef"}' }
  assert.equal(loadConfig(base).forgejoOAuth, undefined)
  const oauth = { ...base, FORGEJO_OAUTH_CLIENT_ID: 'id', FORGEJO_OAUTH_CLIENT_SECRET: 'secret', FORGEJO_OAUTH_REDIRECT_URL: 'http://localhost/oauth/forgejo/callback', FORGEJO_TOKEN_ENCRYPTION_KEY: key.toString('base64'), FORGEJO_PUBLIC_URL: 'http://git.localhost' }
  assert.equal(loadConfig(oauth).forgejoOAuth?.publicUrl.hostname, 'git.localhost')
  assert.throws(() => loadConfig({ ...oauth, FORGEJO_OAUTH_CLIENT_SECRET: '' }), /CLIENT_SECRET/)
  assert.throws(() => loadConfig({ ...oauth, FORGEJO_OAUTH_REDIRECT_URL: 'http://sdlc.example/oauth/forgejo/callback' }), /https, or http on localhost/)
  assert.throws(() => loadConfig({ ...oauth, FORGEJO_OAUTH_REDIRECT_URL: 'https://sdlc.example/else' }), /callback/)
  assert.throws(() => loadConfig({ ...oauth, FORGEJO_TOKEN_ENCRYPTION_KEY: 'short' }), /32 bytes/)
})

test('a call from a user who has not connected carries the approval link, and repeats reuse it', async () => {
  const { oauth, remote } = await setup()
  const client = new ForgejoClient({ baseUrl: internalUrl, token: undefined, allowedRepositories: new Set(), fetch: async () => Response.json([]) })
  const tools = (createForgejoServer(client, false, true, oauth) as unknown as { _registeredTools: Record<string, { handler: (input: unknown, context: unknown) => Promise<unknown> }> })._registeredTools
  const context = { http: { req: new Request('http://x/mcp'), authInfo: { clientId: 'bob', extra: { subject: 'bob' } } } }
  const linkFrom = async () => { try { await tools.list_organizations!.handler({}, context) } catch (error) { return /(http:\/\/localhost\/oauth\/forgejo\/start\?state=[\w-]+)/.exec((error as Error).message)?.[1] } }
  const first = await linkFrom()
  assert(first, 'the error names the link')
  assert.equal(await linkFrom(), first, 'repeated calls do not pile up new links')
  const flow = new URL(first!)
  const redirect = await oauth.handleStart(flow)
  const authorize = new URL(redirect.headers.get('location')!)
  const code = remote.issueCode(authorize.searchParams.get('code_challenge')!)
  const done = await oauth.handleCallback(new Request(`http://localhost/oauth/forgejo/callback?code=${code}&state=${authorize.searchParams.get('state')}`, { headers: { cookie: redirect.headers.get('set-cookie')!.split(';')[0]! } }))
  assert.equal(done.status, 200)
  await tools.list_organizations!.handler({}, context) // now connected: no error
})

test('a client that supports URL elicitation opens the approval page, and the original call finishes after approval', async () => {
  const { oauth, remote } = await setup()
  const seen: Array<string | null> = []
  const client = new ForgejoClient({ baseUrl: internalUrl, token: undefined, allowedRepositories: new Set(), fetch: async (_input, init) => { seen.push(new Headers(init?.headers).get('authorization')); return Response.json([]) } })
  const tools = (createForgejoServer(client, false, true, oauth) as unknown as { _registeredTools: Record<string, { handler: (input: unknown, context: unknown) => Promise<unknown> }> })._registeredTools
  const asks: Array<{ mode: string; url: string }> = []
  const context = {
    http: { req: new Request('http://x/mcp'), authInfo: { clientId: 'carol', extra: { subject: 'carol' } } },
    mcpReq: { elicitInput: async (params: { mode: string; url: string }) => {
      asks.push(params)
      // the user opens the page and approves, which sends the browser back to our callback
      const redirect = await oauth.handleStart(new URL(params.url))
      const authorize = new URL(redirect.headers.get('location')!)
      const code = remote.issueCode(authorize.searchParams.get('code_challenge')!)
      void oauth.handleCallback(new Request(`http://localhost/oauth/forgejo/callback?code=${code}&state=${authorize.searchParams.get('state')}`, { headers: { cookie: redirect.headers.get('set-cookie')!.split(';')[0]! } }))
      return { action: 'accept' }
    } }
  }
  await tools.list_organizations!.handler({}, context)
  assert.equal(asks.length, 1)
  assert.equal(asks[0]!.mode, 'url')
  assert.match(asks[0]!.url, /^http:\/\/localhost\/oauth\/forgejo\/start\?state=/)
  assert.deepEqual(seen, ['Bearer a1'], 'the very call that triggered the prompt completed with the new grant')
})

test('declining, an unsupported client, or an unapproved wait all fall back to the error with the link', async () => {
  const { oauth } = await setup()
  const client = new ForgejoClient({ baseUrl: internalUrl, token: undefined, allowedRepositories: new Set(), fetch: async () => Response.json([]) })
  const tools = (createForgejoServer(client, false, true, oauth) as unknown as { _registeredTools: Record<string, { handler: (input: unknown, context: unknown) => Promise<unknown> }> })._registeredTools
  const base = { http: { req: new Request('http://x/mcp'), authInfo: { clientId: 'dave', extra: { subject: 'dave' } } } }
  const link = /http:\/\/localhost\/oauth\/forgejo\/start\?state=/
  await assert.rejects(() => tools.list_organizations!.handler({}, { ...base, mcpReq: { elicitInput: async () => ({ action: 'decline' }) } }), link)
  await assert.rejects(() => tools.list_organizations!.handler({}, { ...base, mcpReq: { elicitInput: async () => { throw new Error('client does not support url elicitation') } } }), link)
  await assert.rejects(() => tools.list_organizations!.handler({}, base), link)
})

test('waitForGrant resolves false when nobody approves in time and true once someone does', async () => {
  const { oauth, remote } = await setup()
  assert.equal(await oauth.waitForGrant('erin', 20), false)
  const waiting = oauth.waitForGrant('erin', 5000)
  await (await connect(oauth, remote, 'erin')).callback()
  assert.equal(await waiting, true)
})
