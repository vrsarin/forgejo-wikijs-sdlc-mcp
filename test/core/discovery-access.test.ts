import assert from 'node:assert/strict'
import test from 'node:test'
import { discoveryRequestAllowed } from '../../src/core/discovery-access.js'

const request = (body: string) => new Request('http://localhost/mcp', { method: 'POST', body })

test('discovery identity permits only discovery methods', async () => {
  for (const method of ['initialize', 'notifications/initialized', 'ping', 'tools/list']) {
    assert.equal(await discoveryRequestAllowed(request(JSON.stringify({ jsonrpc: '2.0', method }))), true)
  }
  for (const body of [
    JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'connect_forgejo' } }),
    JSON.stringify([{ method: 'tools/list' }, { method: 'tools/call' }]),
    '{}', 'invalid', 'x'.repeat(65537)
  ]) {
    assert.equal(await discoveryRequestAllowed(request(body)), false)
  }
  assert.equal(await discoveryRequestAllowed(new Request('http://localhost/mcp')), false)
})
