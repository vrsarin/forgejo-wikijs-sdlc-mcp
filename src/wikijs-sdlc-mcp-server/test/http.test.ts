import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizeRequest, type HttpServerOptions } from '../src/http.js'

const options: HttpServerOptions = {
  host: '0.0.0.0', port: 3000,
  allowedHosts: new Set(['sdlc.example']),
  allowedOrigins: new Set(),
  auth: { mode: 'static', clientTokens: new Map([['test-client', '0123456789abcdef']]) }
}

test('a configured bot receives its own caller identity', async () => {
  const auth = await authorizeRequest(new Request('https://sdlc.example/mcp', { headers: { authorization: 'Bearer 0123456789abcdef' } }), options)
  assert(!(auth instanceof Response))
  assert.equal(auth.clientId, 'test-client')
})

test('development mode skips bearer authentication but retains request boundaries', async () => {
  const development = { ...options, auth: { mode: 'none' as const } }
  const auth = await authorizeRequest(new Request('https://sdlc.example/mcp'), development)
  assert(!(auth instanceof Response))
  assert.equal(auth.clientId, 'development-anonymous')
  assert.equal((await authorizeRequest(new Request('https://other.example/mcp'), development) as Response).status, 403)
})
