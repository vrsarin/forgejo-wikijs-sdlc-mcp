import assert from 'node:assert/strict'
import test from 'node:test'
import { beginWikiSso } from '../src/oauth/wiki-sso.js'

const wikiUrl = new URL('http://wiki.localhost/_mcp')
const callbackUrl = new URL('http://localhost/oauth/wikijs/callback')
const site = '11111111-1111-4111-8111-111111111111'
const strategy = '22222222-2222-4222-8222-222222222222'
const consent = `/_authorize?${new URLSearchParams({ client_id: 'client', redirect_uri: callbackUrl.toString(), state: 'state' })}`
const request = (redirect: string, headers?: HeadersInit) => new Request(new URL(redirect, wikiUrl.origin), headers ? { headers } : undefined)
const fetcher: typeof globalThis.fetch = async (input) => {
  const url = new URL(String(input))
  if (url.pathname === '/_api/oauth/authorize') return new Response(null, { status: 401 })
  if (url.pathname === '/_api/bootstrap') return Response.json({ site: { id: site } })
  assert.equal(url.pathname, `/_api/sites/${site}/auth/strategies`)
  return Response.json([{ id: strategy, isVisible: true, activeStrategy: { displayName: 'Keycloak', strategy: { key: 'oidc' } } }])
}

test('only the Wiki.js MCP consent login redirects to the configured Keycloak strategy', async () => {
  const response = await beginWikiSso(request(consent), { wikiUrl, callbackUrl, fetch: fetcher })
  assert.equal(response.status, 302)
  const target = new URL(response.headers.get('location')!)
  assert.equal(target.origin, wikiUrl.origin)
  assert.equal(target.pathname, `/_api/auth/${strategy}/authorize`)
  assert.equal(target.searchParams.get('siteId'), site)
  const returnTo = new URL(target.searchParams.get('redirect')!, wikiUrl.origin)
  assert.equal(returnTo.pathname, '/_authorize')
  assert.equal(returnTo.searchParams.get('state'), 'state')
  assert.equal(returnTo.searchParams.get('mcp_sso'), '1')
})

test('unrelated, malformed, or ambiguous redirects and unconfigured identity providers are refused', async () => {
  for (const redirect of ['/home', '//other.example/_authorize', '/_authorize?redirect_uri=http://evil.example', `${consent}&redirect_uri=http://evil.example`]) {
    assert.equal((await beginWikiSso(request(redirect), { wikiUrl, callbackUrl, fetch: fetcher })).status, 400)
  }
  const unavailable: typeof globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    return path === '/_api/oauth/authorize' ? new Response(null, { status: 401 })
      : path === '/_api/bootstrap' ? Response.json({ site: { id: site } }) : Response.json([])
  }
  assert.equal((await beginWikiSso(request(consent), { wikiUrl, callbackUrl, fetch: unavailable })).status, 502)
  const failed: typeof globalThis.fetch = async () => new Response(null, { status: 503 })
  const response = await beginWikiSso(request(consent), { wikiUrl, callbackUrl, fetch: failed })
  assert.equal(response.status, 502)
  assert.equal(response.headers.get('location'), null)
})

test('an existing Wiki.js session is retained without starting another identity-provider login', async () => {
  const session: typeof globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/_api/oauth/authorize')
    assert.equal(new Headers(init?.headers).get('cookie'), 'wiki_session=existing')
    return Response.json({ mayUse: true })
  }
  const response = await beginWikiSso(request(consent, { cookie: 'wiki_session=existing' }), { wikiUrl, callbackUrl, fetch: session })
  assert.equal(response.status, 302)
  const target = new URL(response.headers.get('location')!, wikiUrl.origin)
  assert.equal(target.pathname, '/_authorize')
  assert.equal(target.searchParams.get('mcp_sso'), '1')
  assert.equal(target.searchParams.get('state'), 'state')
})

test('a session without use:mcp is reauthenticated once to refresh its group membership', async () => {
  const staleSession: typeof globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/_api/oauth/authorize') {
      assert.equal(new Headers(init?.headers).get('cookie'), 'wiki_session=stale')
      return Response.json({ mayUse: false })
    }
    return fetcher(input, init)
  }
  const response = await beginWikiSso(request(consent, { cookie: 'wiki_session=stale' }), { wikiUrl, callbackUrl, fetch: staleSession })
  const target = new URL(response.headers.get('location')!)
  assert.equal(target.pathname, `/_api/auth/${strategy}/authorize`)
  assert.equal(new URL(target.searchParams.get('redirect')!, wikiUrl.origin).searchParams.get('mcp_sso'), '1')
})
