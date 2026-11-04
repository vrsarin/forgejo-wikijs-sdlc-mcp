import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizeRequest, type HttpServerOptions } from '../../src/core/http.js'

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
