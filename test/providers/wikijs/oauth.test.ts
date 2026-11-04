import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../../src/providers/wikijs/config.js'
import { EncryptedFileStore } from '../../../src/core/encrypted-file-store.js'
import { ProviderOAuth } from '../../../src/providers/wikijs/provider-oauth.js'
import { createWikiJsSdlcServer } from '../../../src/providers/wikijs/server.js'

const key = randomBytes(32)
const wiki = new URL('http://wiki.localhost')
const redirectUrl = new URL('http://localhost/oauth/wikijs/callback')

/** A stand-in for the Wiki.js authorization server: public PKCE clients and rotating refresh tokens. */
function fakeWiki() {
  const calls: string[] = []
  let issued = 0
  const codes = new Map<string, { challenge: string; clientId: string }>()
  const refreshes = new Map<string, string>()
  let revoked = false
  const mint = () => { issued += 1; const refresh = `r${issued}`; refreshes.set(refresh, 'live'); return { access_token: `a${issued}`, refresh_token: refresh, expires_in: 3600, scope: 'mcp:read pages:read' } }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    calls.push(url.pathname)
    if (url.pathname === '/_oauth/register') return Response.json({ client_id: 'client-1' }, { status: 201 })
    const form = new URLSearchParams(String(init?.body))
    if (form.get('grant_type') === 'authorization_code') {
      const code = codes.get(form.get('code') ?? '')
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
      if (!code || code.challenge !== challenge || form.get('resource') !== 'http://wiki.localhost/_mcp') return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return Response.json(mint())
    }
    const state = refreshes.get(form.get('refresh_token') ?? '')
    if (revoked || state !== 'live') { revoked = true; return Response.json({ error: 'invalid_grant', error_description: 'revoked' }, { status: 400 }) }
    refreshes.set(form.get('refresh_token')!, 'used')
    return Response.json(mint())
  }
  return { fetch, calls, issueCode: (challenge: string) => { const code = `code-${codes.size}`; codes.set(code, { challenge, clientId: 'client-1' }); return code }, mint }
}

async function setup(now = { t: 1_000_000 }) {
  const dir = await mkdtemp(join(tmpdir(), 'provider-oauth-'))
  const path = join(dir, 'grants.enc')
  const remote = fakeWiki()
  const oauth = new ProviderOAuth({ wikiOrigin: wiki, redirectUrl, scopes: 'mcp:read pages:read', store: new EncryptedFileStore(path, key), fetch: remote.fetch, now: () => now.t })
  return { oauth, remote, path, now }
}

/** Walk the browser legs the way a user would. */
async function connect(oauth: ProviderOAuth, remote: ReturnType<typeof fakeWiki>, sub: string) {
  const start = new URL(await oauth.beginConnect(sub))
  const redirect = await oauth.handleStart(start)
  assert.equal(redirect.status, 302)
  const authorize = new URL(redirect.headers.get('location')!)
  assert.equal(authorize.origin, 'http://wiki.localhost')
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorize.searchParams.get('resource'), 'http://wiki.localhost/_mcp')
  const cookie = redirect.headers.get('set-cookie')!.split(';')[0]!
  const code = remote.issueCode(authorize.searchParams.get('code_challenge')!)
  const state = authorize.searchParams.get('state')!
  return { cookie, state, callback: (extra = '', headers: Record<string, string> = { cookie }) => oauth.handleCallback(new Request(`http://localhost/oauth/wikijs/callback?code=${code}&state=${state}${extra}`, { headers })) }
}

test('a user connects once and then gets their own token with no paste', async () => {
  const { oauth, remote } = await setup()
  const flow = await connect(oauth, remote, 'alice')
  assert.equal((await flow.callback()).status, 200)
  assert.equal(await oauth.accessToken('alice'), 'a1')
  assert.equal(await oauth.accessToken('bob'), undefined)
  assert.equal(await oauth.isConnected('alice'), true)
})

test('the client is registered with the wiki once and reused', async () => {
  const { oauth, remote } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  await (await connect(oauth, remote, 'bob')).callback()
  assert.equal(remote.calls.filter((path) => path === '/_oauth/register').length, 1)
})

test('the callback is refused from a different browser, replayed, or after expiry', async () => {
  const a = await setup()
  const other = await connect(a.oauth, a.remote, 'alice')
  assert.equal((await other.callback('', { cookie: 'wikijs_oauth=stolen' })).status, 400)
  assert.equal(await a.oauth.accessToken('alice'), undefined)
  assert.equal((await other.callback()).status, 400, 'a state is single use even after a failed attempt')

  const b = await setup()
  const flow = await connect(b.oauth, b.remote, 'alice')
  assert.equal((await flow.callback('', {})).status, 400, 'no cookie, no connection')

  const c = await setup()
  const late = await connect(c.oauth, c.remote, 'alice')
  c.now.t += 11 * 60 * 1000
  assert.equal((await late.callback()).status, 400)
})

test('a denied consent connects nothing', async () => {
  const { oauth, remote } = await setup()
  const flow = await connect(oauth, remote, 'alice')
  const response = await oauth.handleCallback(new Request(`http://localhost/oauth/wikijs/callback?error=access_denied&state=${flow.state}`, { headers: { cookie: flow.cookie } }))
  assert.equal(response.status, 403)
  assert.equal(await oauth.isConnected('alice'), false)
})

test('an expiring token is refreshed once even when requests overlap, and the rotation is kept', async () => {
  const { oauth, remote, now } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  now.t += 3600 * 1000 - 30_000 // within the refresh margin
  const tokens = await Promise.all([oauth.accessToken('alice'), oauth.accessToken('alice'), oauth.accessToken('alice')])
  assert.deepEqual(new Set(tokens), new Set(['a2']))
  assert.equal(remote.calls.filter((path) => path === '/_oauth/token').length, 2, 'one exchange plus exactly one refresh')
  assert.equal(await oauth.accessToken('alice'), 'a2')
})

test('a revoked grant is forgotten so the user is told to connect again', async () => {
  const { oauth, remote, now } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  // The refresh token gets used somewhere else, so Wiki.js treats ours as stolen and revokes the grant.
  await remote.fetch('http://wiki.localhost/_oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'client-1' }) })
  now.t += 3600 * 1000
  assert.equal(await oauth.accessToken('alice'), undefined)
  assert.equal(await oauth.isConnected('alice'), false)
})

test('grants survive a restart and are encrypted at rest', async () => {
  const { oauth, remote, path } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  const raw = await readFile(path, 'utf8')
  for (const secret of ['alice', 'accessToken', 'refreshToken', 'client-1']) assert(!raw.includes(secret), `${secret} must not appear in plaintext`)
  const restarted = new ProviderOAuth({ wikiOrigin: wiki, redirectUrl, scopes: 'mcp:read', store: new EncryptedFileStore(path, key), fetch: remote.fetch, now: () => 1_000_000 })
  assert.equal(await restarted.accessToken('alice'), 'a1')
  const wrongKey = new EncryptedFileStore(path, randomBytes(32))
  await assert.rejects(() => wrongKey.load())
})

test('disconnect forgets the grant', async () => {
  const { oauth, remote } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  assert.equal(await oauth.disconnect('alice'), true)
  assert.equal(await oauth.accessToken('alice'), undefined)
  assert.equal(await oauth.disconnect('alice'), false)
})

test('tools use the stored grant for the verified user and never another user\'s', async () => {
  const { oauth, remote } = await setup()
  await (await connect(oauth, remote, 'alice')).callback()
  const seen: Array<string | null> = []
  const { WikiJsClient } = await import('../../../src/providers/wikijs/wikijs.js')
  const client = new WikiJsClient({ mcpUrl: new URL('http://wiki.localhost/_mcp'), fetch: async (_input, init) => {
    seen.push(new Headers(init?.headers).get('authorization'))
    const body = JSON.parse(String(init?.body))
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { serverInfo: { name: 'wiki' } } : { tools: [{ name: 'search_pages' }] } })
  } })
  const tools = (createWikiJsSdlcServer(new URL('http://wiki.localhost/_mcp'), client, oauth) as unknown as { _registeredTools: Record<string, { handler: (context: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools
  const as = (subject: string) => ({ http: { req: new Request('http://x/mcp'), authInfo: { clientId: subject, extra: { subject } } } })
  await tools.discover_wikijs_capabilities!.handler(as('alice'))
  assert.deepEqual(seen, ['Bearer a1', 'Bearer a1', 'Bearer a1'])
  await assert.rejects(() => tools.discover_wikijs_capabilities!.handler(as('bob')), /connect_wikijs/)
  const link = JSON.parse((await tools.connect_wikijs!.handler(as('bob'))).content[0]!.text)
  assert.match(link.authorizeUrl, /^http:\/\/localhost\/oauth\/wikijs\/start\?state=/)
  assert.equal(JSON.parse((await tools.connect_wikijs!.handler(as('alice'))).content[0]!.text).connected, true)
  await assert.rejects(() => tools.connect_wikijs!.handler({ http: { req: new Request('http://x/mcp'), authInfo: { clientId: 'static' } } }), /Sign in with Keycloak/)
})

test('OAuth configuration is validated', () => {
  const base = { MCP_CLIENT_TOKENS: '{"vscode":"0123456789abcdef"}', WIKIJS_MCP_URL: 'http://wiki.localhost/_mcp', WIKIJS_ALLOW_INSECURE_MCP_HTTP: 'true', WIKIJS_TOKEN_ENCRYPTION_KEY: key.toString('base64') }
  assert.equal(loadConfig(base).providerOAuth, undefined)
  assert.equal(loadConfig({ ...base, WIKIJS_OAUTH_REDIRECT_URL: 'http://localhost/oauth/wikijs/callback' }).providerOAuth?.redirectUrl.pathname, '/oauth/wikijs/callback')
  assert.throws(() => loadConfig({ ...base, WIKIJS_OAUTH_REDIRECT_URL: 'http://sdlc-mcp.localhost/oauth/wikijs/callback' }), /https, or http on localhost/)
  assert.throws(() => loadConfig({ ...base, WIKIJS_OAUTH_REDIRECT_URL: 'https://sdlc.example/elsewhere' }), /callback/)
  assert.throws(() => loadConfig({ ...base, WIKIJS_OAUTH_REDIRECT_URL: 'https://sdlc.example/oauth/wikijs/callback', WIKIJS_TOKEN_ENCRYPTION_KEY: 'short' }), /32 bytes/)
})

test('a call from a user who has not connected carries the approval link, and repeats reuse it', async () => {
  const { oauth } = await setup()
  const { WikiJsClient } = await import('../../../src/providers/wikijs/wikijs.js')
  const client = new WikiJsClient({ mcpUrl: new URL('http://wiki.localhost/_mcp'), fetch: async () => Response.json({}) })
  const tools = (createWikiJsSdlcServer(new URL('http://wiki.localhost/_mcp'), client, oauth) as unknown as { _registeredTools: Record<string, { handler: (context: unknown) => Promise<unknown> }> })._registeredTools
  const context = { http: { req: new Request('http://x/mcp'), authInfo: { clientId: 'bob', extra: { subject: 'bob' } } } }
  const linkFrom = async () => { try { await tools.discover_wikijs_capabilities!.handler(context) } catch (error) { return /(http:\/\/localhost\/oauth\/wikijs\/start\?state=[\w-]+)/.exec((error as Error).message)?.[1] } }
  const first = await linkFrom()
  assert(first, 'the error names the link')
  assert.equal(await linkFrom(), first, 'repeated calls do not pile up new links')
})

test('URL elicitation completes the original call after approval, and falls back to the link otherwise', async () => {
  const { oauth, remote } = await setup()
  const { WikiJsClient } = await import('../../../src/providers/wikijs/wikijs.js')
  const seen: Array<string | null> = []
  const client = new WikiJsClient({ mcpUrl: new URL('http://wiki.localhost/_mcp'), fetch: async (_input, init) => {
    seen.push(new Headers(init?.headers).get('authorization'))
    const body = JSON.parse(String(init?.body))
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { serverInfo: { name: 'wiki' } } : { tools: [] } })
  } })
  const tools = (createWikiJsSdlcServer(new URL('http://wiki.localhost/_mcp'), client, oauth) as unknown as { _registeredTools: Record<string, { handler: (context: unknown) => Promise<unknown> }> })._registeredTools
  const identity = { http: { req: new Request('http://x/mcp'), authInfo: { clientId: 'carol', extra: { subject: 'carol' } } } }
  const approving = { ...identity, mcpReq: { elicitInput: async (params: { url: string }) => {
    const redirect = await oauth.handleStart(new URL(params.url))
    const authorize = new URL(redirect.headers.get('location')!)
    const code = remote.issueCode(authorize.searchParams.get('code_challenge')!)
    void oauth.handleCallback(new Request(`http://localhost/oauth/wikijs/callback?code=${code}&state=${authorize.searchParams.get('state')}`, { headers: { cookie: redirect.headers.get('set-cookie')!.split(';')[0]! } }))
    return { action: 'accept' }
  } } }
  await tools.discover_wikijs_capabilities!.handler(approving)
  assert.deepEqual(seen, ['Bearer a1', 'Bearer a1', 'Bearer a1'])
  const bob = { http: { req: new Request('http://x/mcp'), authInfo: { clientId: 'bob', extra: { subject: 'bob' } } } }
  const link = /http:\/\/localhost\/oauth\/wikijs\/start\?state=/
  await assert.rejects(() => tools.discover_wikijs_capabilities!.handler({ ...bob, mcpReq: { elicitInput: async () => ({ action: 'decline' }) } }), link)
  await assert.rejects(() => tools.discover_wikijs_capabilities!.handler(bob), link)
})
