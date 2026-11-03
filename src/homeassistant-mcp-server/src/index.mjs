import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { EncryptedFileStore } from '../store.js'
import { createMcpHttpServer, tlsFilesFromEnvironment } from '../tls-http.js'
import { HomeAssistantOAuth } from '../homeassistant-oauth.mjs'
import { HomeAssistantVerifier } from './auth.mjs'
import { createHomeAssistantApp } from './app.mjs'

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const issuer = required('MCP_OIDC_ISSUER')
const encryptionKey = Buffer.from(required('HOMEASSISTANT_TOKEN_ENCRYPTION_KEY'), 'base64')
if (encryptionKey.length !== 32) throw new Error('HOMEASSISTANT_TOKEN_ENCRYPTION_KEY must be 32 bytes')
const discoverySubject = readFileSync(required('HOMEASSISTANT_DISCOVERY_SUBJECT_FILE'), 'utf8').trim()
if (!/^[0-9a-f-]{36}$/i.test(discoverySubject)) throw new Error('Home Assistant discovery subject is invalid')
const upstream = required('HOMEASSISTANT_INTERNAL_URL')
const oauth = new HomeAssistantOAuth({
  publicUrl: required('HOMEASSISTANT_PUBLIC_URL'), internalUrl: upstream,
  callbackUrl: 'http://localhost/oauth/homeassistant/callback', issuer,
  store: new EncryptedFileStore(process.env.HOMEASSISTANT_TOKEN_STORE_PATH || '/data/homeassistant-grants.enc', encryptionKey)
})
const verifier = new HomeAssistantVerifier({
  issuer, audience: required('MCP_OIDC_AUDIENCE'), discoveryClient: 'mcp-gateway-discovery'
})
const app = createHomeAssistantApp({
  verifier, oauth, discoverySubject, upstream,
  allowedHosts: new Set(['localhost', '127.0.0.1', 'homeassistant-mcp', 'homeassistant-mcp-tls'])
})
const tls = tlsFilesFromEnvironment(process.env)
const server = createMcpHttpServer((incoming, outgoing) => {
  void (async () => {
    try {
      const host = incoming.headers.host
      if (!host) {
        outgoing.writeHead(400)
        outgoing.end('Host is required')
        return
      }
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(name, value)
        else if (value) for (const item of value) headers.append(name, item)
      }
      const request = new Request(`${tls ? 'https' : 'http'}://${host}${incoming.url || '/'}`, {
        method: incoming.method, headers,
        ...(incoming.method !== 'GET' && incoming.method !== 'HEAD'
          ? { body: Readable.toWeb(incoming), duplex: 'half' } : {})
      })
      const response = await app(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (!response.body) return outgoing.end()
      const body = Readable.fromWeb(response.body)
      body.on('error', () => {
        console.error('Home Assistant MCP response stream failed')
        outgoing.destroy()
      })
      body.pipe(outgoing)
    } catch (error) {
      console.error('Home Assistant MCP HTTP request failed:', error instanceof Error ? error.name : 'unknown error')
      if (!outgoing.headersSent) outgoing.writeHead(500)
      outgoing.end('Internal error')
    }
  })()
}, tls)
server.listen(Number(process.env.MCP_PORT || 3000), '0.0.0.0', () => {
  console.error(`Home Assistant MCP adapter listening on ${tls ? 'https' : 'http'} port 3000`)
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close())
