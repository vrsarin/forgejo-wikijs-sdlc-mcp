import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizeRequest, classifyMcpRequest, type HttpServerOptions } from '../../src/core/http.js'

const options: HttpServerOptions = {
  host: '0.0.0.0', port: 3000,
  allowedHosts: new Set(['mcp.example']),
  allowedOrigins: new Set(['https://client.example']),
  auth: { mode: 'static', clientTokens: new Map([['vscode', '0123456789abcdef']]) }
}

test('HTTP authentication identifies each client', async () => {
  const request = new Request('https://mcp.example/mcp', { headers: { authorization: 'Bearer 0123456789abcdef' } })
  const auth = await authorizeRequest(request, options)
  assert(!(auth instanceof Response))
  assert.equal(auth.clientId, 'vscode')
})

test('HTTP authentication rejects invalid hosts and tokens', async () => {
  assert.equal((await authorizeRequest(new Request('https://other.example/mcp'), options) as Response).status, 403)
  assert.equal((await authorizeRequest(new Request('https://mcp.example/mcp'), options) as Response).status, 401)
})

test('development mode skips bearer authentication but retains host and origin boundaries', async () => {
  const development = { ...options, auth: { mode: 'none' as const } }
  const auth = await authorizeRequest(new Request('https://mcp.example/mcp'), development)
  assert(!(auth instanceof Response))
  assert.equal(auth.clientId, 'development-anonymous')
  assert.equal((await authorizeRequest(new Request('https://other.example/mcp'), development) as Response).status, 403)
})

test('request classification preserves the mutation budget for large valid tool calls', async () => {
  const argumentsValue = { body: 'x'.repeat(128 * 1024) }
  const tool = new Request('https://mcp.example/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_issue', arguments: argumentsValue } }) })
  assert.equal(await classifyMcpRequest(tool), 'tool')
  assert.equal(await classifyMcpRequest(new Request('https://mcp.example/mcp', { method: 'POST', body: JSON.stringify({ method: 'tools/list' }) })), 'discovery')
  await assert.rejects(() => classifyMcpRequest(new Request('https://mcp.example/mcp', { method: 'POST', body: '{' })), SyntaxError)
  await assert.rejects(
    () => classifyMcpRequest(new Request('https://mcp.example/mcp', { method: 'POST', body: JSON.stringify({ method: 'tools/call', value: 'x'.repeat(4 * 1024 * 1024) }) })),
    RangeError
  )
})
