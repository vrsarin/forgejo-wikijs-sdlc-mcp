import assert from 'node:assert/strict'
import test from 'node:test'
import { createHomeAssistantApp } from '../../../src/providers/homeassistant/app.js'
import { requireHomeAssistantOidc } from '../../../src/providers/homeassistant/runtime.js'

function fixture({ connected = true } = {}) {
  const calls = []
  const verifier = { verify: async (token) => {
    if (token === 'scanner') return { subject: 'machine', discovery: true }
    if (token === 'user') return { subject: 'alice', discovery: false }
    throw new Error('Rejected')
  } }
  const oauth = {
    accessToken: async (subject) => subject === 'scanner-user' ? 'scanner-grant' : connected && subject === 'alice' ? 'alice-grant' : undefined,
    isConnected: async () => connected,
    beginConnect: async (subject) => `http://localhost/oauth/homeassistant/start?subject=${subject}`,
    disconnect: async () => true
  }
  const app = createHomeAssistantApp({
    verifier, oauth, discoverySubject: 'scanner-user', upstream: 'https://home-assistant-upstream-tls',
    allowedHosts: new Set(['homeassistant-mcp']),
    fetcher: async (_url, options) => {
      const request = JSON.parse(options.body)
      calls.push({ request, authorization: options.headers.authorization })
      if (request.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'HassTurnOn' }] } }))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }))
    }
  })
  const request = (token, method, params = {}) => app(new Request('http://homeassistant-mcp/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  }))
  return { app, request, calls }
}

test('discovery may list tools but cannot call them', async () => {
  const { request, calls } = fixture()
  const listed = await request('scanner', 'tools/list')
  assert.equal(listed.status, 200)
  assert.deepEqual((await listed.json()).result.tools.map((tool) => tool.name), ['HassTurnOn', 'connect_home_assistant', 'disconnect_home_assistant'])
  assert.equal((await request('scanner', 'tools/call', { name: 'HassTurnOn', arguments: {} })).status, 403)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].authorization, 'Bearer scanner-grant')
})

test('normal tool calls use only the authenticated user grant', async () => {
  const { request, calls } = fixture()
  assert.equal((await request('user', 'tools/call', { name: 'HassTurnOn', arguments: {} })).status, 200)
  assert.equal(calls[0].authorization, 'Bearer alice-grant')
  assert.equal((await request('nonmember', 'tools/call', { name: 'HassTurnOn' })).status, 401)
  assert.equal(calls.length, 1)
})

test('missing user grant returns a consent link without using discovery credentials', async () => {
  const { request, calls } = fixture({ connected: false })
  const body = await (await request('user', 'tools/call', { name: 'HassTurnOn', arguments: {} })).json()
  assert.equal(body.result.isError, true)
  assert.match(body.result.content[0].text, /oauth\/homeassistant\/start/)
  assert.equal(calls.length, 0)
})

test('rejects invalid hosts and JSON-RPC batches', async () => {
  const { app } = fixture()
  assert.equal((await app(new Request('http://other/mcp', { method: 'POST' }))).status, 403)
  const batch = await app(new Request('http://homeassistant-mcp/mcp', {
    method: 'POST', headers: { authorization: 'Bearer scanner' }, body: JSON.stringify([{ method: 'tools/list' }, { method: 'tools/call' }])
  }))
  assert.equal(batch.status, 400)
  const origin = await app(new Request('http://homeassistant-mcp/mcp', {
    method: 'POST', headers: { authorization: 'Bearer user', origin: 'https://other.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  }))
  assert.equal(origin.status, 403)
  const noId = await app(new Request('http://homeassistant-mcp/mcp', {
    method: 'POST', headers: { authorization: 'Bearer user' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call' })
  }))
  assert.equal(noId.status, 400)
})

test('rejects an unencrypted Home Assistant upstream', () => {
  assert.throws(() => createHomeAssistantApp({
    verifier: {}, oauth: {}, discoverySubject: 'scanner', upstream: 'http://home-assistant:8123',
    allowedHosts: new Set(['homeassistant-mcp'])
  }), /Invalid Home Assistant MCP upstream/)
})

test('Home Assistant OIDC configuration fails closed without its group or discovery client', () => {
  const base = { mode: 'oidc', issuer: new URL('https://login.example/realms/sdlc'), audience: 'homeassistant', resource: new URL('https://mcp.example/mcp'), requiredRealmRole: 'mcp-user', requiredRole: 'mcp-user' }
  assert.throws(() => requireHomeAssistantOidc(base), /MCP_OIDC_REQUIRED_GROUP/)
  assert.throws(() => requireHomeAssistantOidc({ ...base, requiredGroup: 'home-assistant-users' }), /MCP_OIDC_DISCOVERY_CLIENT_ID/)
  assert.equal(requireHomeAssistantOidc({ ...base, requiredGroup: 'home-assistant-users', discoveryClientId: 'mcp-gateway-discovery' }).mode, 'oidc')
})
