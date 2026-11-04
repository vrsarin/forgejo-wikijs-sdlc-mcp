import assert from 'node:assert/strict'
import test from 'node:test'
import { WikiJsClient, WikiJsError } from '../../../src/providers/wikijs/wikijs.js'
import { createWikiJsSdlcServer } from '../../../src/providers/wikijs/server.js'

const url = new URL('https://wiki.example/_mcp')
function client(respond: (body: any, auth: string | null) => Response) {
  const seen: Array<{ method: string; auth: string | null; session: string | null }> = []
  return { seen, client: new WikiJsClient({ mcpUrl: url, fetch: async (_input, init) => {
    const body = JSON.parse(String(init?.body)); const headers = new Headers(init?.headers); const auth = headers.get('authorization')
    seen.push({ method: body.method, auth, session: headers.get('mcp-session-id') }); return respond(body, auth)
  } }) }
}
const ok = (body: any) => Response.json(
  { jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'wiki', version: '3' } } : { tools: [{ name: 'search_pages', description: 'Search', extra: 'dropped' }] } },
  body.method === 'initialize' ? { headers: { 'mcp-session-id': 'wiki-session' } } : undefined
)

test('discovery forwards the caller token and returns the tool list', async () => {
  const { seen, client: wiki } = client((body) => ok(body))
  const found = await wiki.discover('user-token')
  assert.deepEqual(found.tools, [{ name: 'search_pages', description: 'Search' }])
  assert.equal(found.server.name, 'wiki')
  assert.deepEqual(seen, [
    { method: 'initialize', auth: 'Bearer user-token', session: null },
    { method: 'notifications/initialized', auth: 'Bearer user-token', session: 'wiki-session' },
    { method: 'tools/list', auth: 'Bearer user-token', session: 'wiki-session' }
  ])
})

test('each user is discovered with their own token', async () => {
  const { seen, client: wiki } = client((body) => ok(body))
  await wiki.discover('alice-token'); await wiki.discover('bob-token')
  assert.deepEqual([...new Set(seen.map((call) => call.auth))], ['Bearer alice-token', 'Bearer bob-token'])
})

test('Wiki.js refusals surface their reason without echoing the token', async () => {
  const { client: wiki } = client(() => Response.json({ jsonrpc: '2.0', id: null, error: { message: 'The owner of this token does not hold the use:mcp permission.' } }, { status: 403 }))
  await assert.rejects(() => wiki.discover('secret-token'), (error: unknown) => error instanceof WikiJsError && error.status === 403 && /use:mcp/.test(error.message) && !error.message.includes('secret-token'))
})

test('the discovery tool refuses to run without a per-user token', async () => {
  const tools = (createWikiJsSdlcServer(url, client((body) => ok(body)).client) as unknown as { _registeredTools: Record<string, { handler: (context: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools
  const tool = tools.discover_wikijs_capabilities!
  await assert.rejects(() => tool.handler({ http: { req: new Request('https://x/mcp') } }), /personal access token/)
  const result = await tool.handler({ http: { req: new Request('https://x/mcp', { headers: { 'x-wikijs-token': 'user-token' } }), authInfo: { clientId: 'vivek' } } })
  assert.equal(JSON.parse(result.content[0]!.text).caller, 'vivek')
})

test('stdio discovery uses only its explicit single-user token', async () => {
  const { seen, client: wiki } = client((body) => ok(body))
  const tools = (createWikiJsSdlcServer(url, wiki, undefined, 'stdio-user-token') as unknown as { _registeredTools: Record<string, { handler: (context: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools
  const result = await tools.discover_wikijs_capabilities!.handler({})
  assert.equal(JSON.parse(result.content[0]!.text).caller, 'stdio-client')
  assert.deepEqual([...new Set(seen.map((call) => call.auth))], ['Bearer stdio-user-token'])
})
