#!/usr/bin/env node

const endpoint = new URL(process.argv[2] || 'http://127.0.0.1:3010/mcp')
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
if (process.env.MCP_BEARER_TOKEN) headers.authorization = `Bearer ${process.env.MCP_BEARER_TOKEN}`
if (process.env.MCP_PROVIDER_TOKEN) {
  const name = (process.env.MCP_PROVIDER_TOKEN_HEADER || '').toLowerCase()
  if (!['x-forgejo-token', 'x-wikijs-token'].includes(name)) throw new Error('MCP_PROVIDER_TOKEN_HEADER must be x-forgejo-token or x-wikijs-token')
  headers[name] = process.env.MCP_PROVIDER_TOKEN
}

let session
let id = 0
function parseBody(text) {
  const event = text.split('\n').find((line) => line.startsWith('data: '))
  return JSON.parse(event ? event.slice(6) : text)
}
async function rpc(method, params = {}, notification = false) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++id }), method, params }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  })
  session ||= response.headers.get('mcp-session-id')
  if (notification && response.ok) return
  const text = await response.text()
  const message = parseBody(text)
  if (!response.ok || message.error) throw new Error(`${method} failed (HTTP ${response.status}): ${message.error?.message || text}`)
  return message.result
}

const initialized = await rpc('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'sdlc-mcp-smoke', version: '1.0.0' }
})
await rpc('notifications/initialized', {}, true)
const catalog = await rpc('tools/list')
if (!Array.isArray(catalog.tools) || catalog.tools.length === 0) throw new Error('tools/list returned no tools')
console.log(`PASS ${endpoint}: protocol ${initialized.protocolVersion}, ${catalog.tools.length} tools`)
