import { connectionToolDefinitions } from '../../core/connection-tools.js'
import { DISCOVERY_METHODS } from '../../core/discovery-access.js'
import { readBounded } from '../../core/read-bounded.js'
import { oauthPaths } from '../../core/provider.js'
import { isAllowedHost } from '../../core/http-util.js'
import { definition } from './definition.js'
import { enforceRateLimit, FixedWindowRateLimiter } from '../../core/rate-limit.js'

const maxRequestBytes = 256 * 1024
const maxResponseBytes = 2 * 1024 * 1024
const manageTools = connectionToolDefinitions({
  id: 'home_assistant',
  connectDescription: 'Connect your own Home Assistant account using Keycloak SSO.',
  disconnectDescription: 'Remove your stored Home Assistant grant from this MCP adapter.'
})

interface Caller { subject: string; discovery: boolean }
interface Verifier { verify(token: string): Promise<Caller> }
interface OAuth {
  accessToken(subject: string): Promise<string | undefined>
  isConnected(subject: string): Promise<boolean>
  beginConnect(subject: string): Promise<string>
  disconnect(subject: string): Promise<boolean>
  handleStart(url: URL): Promise<Response> | Response
  handleCallback(request: Request): Promise<Response>
}
interface JsonRpcMessage { jsonrpc: '2.0'; id?: string | number; method: string; params?: unknown }

export interface HomeAssistantAppOptions {
  verifier: Verifier
  oauth: OAuth
  discoverySubject: string
  upstream: string | URL
  allowedHosts: ReadonlySet<string>
  fetcher?: typeof globalThis.fetch
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
})
const toolResult = (id: JsonRpcMessage['id'], value: unknown, isError = false) => json({
  jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }
})
const rpcError = (id: JsonRpcMessage['id'], code: number, message: string) => json({ jsonrpc: '2.0', id, error: { code, message } })

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validManagedToolCall(params: unknown): params is { name: string; arguments?: Record<string, never> } {
  if (!record(params) || typeof params.name !== 'string') return false
  if (Object.keys(params).some((key) => !['name', 'arguments', '_meta'].includes(key))) return false
  return params.arguments === undefined || (record(params.arguments) && Object.keys(params.arguments).length === 0)
}

export function createHomeAssistantApp(options: HomeAssistantAppOptions): (request: Request) => Promise<Response> {
  const { verifier, oauth, discoverySubject, allowedHosts, fetcher = globalThis.fetch } = options
  if (!verifier || !oauth || !discoverySubject || !options.upstream || !allowedHosts.size) throw new Error('Home Assistant adapter configuration is incomplete')
  const upstreamUrl = new URL('/api/mcp', options.upstream)
  const oauthRoutes = oauthPaths(definition)
  const rateLimiter = new FixedWindowRateLimiter()
  const sessionOwners = new Map<string, string>()
  if (upstreamUrl.origin !== 'https://home-assistant-upstream-tls' || upstreamUrl.username || upstreamUrl.password) {
    throw new Error('Invalid Home Assistant MCP upstream')
  }

  const forward = async (message: JsonRpcMessage, token: string, sessionId: string | null, owner: string): Promise<Response> => {
    if (sessionId && sessionOwners.get(sessionId) !== owner) return json({ error: 'MCP session is not valid for this caller' }, 403)
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const response = await fetcher(upstreamUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers,
      body: JSON.stringify(message)
    })
    const responseSession = response.headers.get('mcp-session-id')
    if (responseSession) {
      sessionOwners.set(responseSession, owner)
      while (sessionOwners.size > 10_000) sessionOwners.delete(sessionOwners.keys().next().value as string)
    }
    const responseHeaders = { ...(responseSession ? { 'mcp-session-id': responseSession } : {}) }
    if (response.status === 202) return new Response(null, { status: 202, headers: responseHeaders })
    const body = (await readBounded(response.body, maxResponseBytes)).toString('utf8')
    if (!response.ok) throw new Error(`Home Assistant MCP request failed (HTTP ${response.status})`)
    return new Response(body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', ...responseHeaders } })
  }

  const verify = async (request: Request): Promise<Caller | undefined> => {
    const authorization = request.headers.get('authorization')
    if (!authorization?.startsWith('Bearer ') || !authorization.slice(7)) return undefined
    try { return await verifier.verify(authorization.slice(7)) } catch {
      console.error('Home Assistant MCP authentication failed; token details were redacted')
      return undefined
    }
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (!isAllowedHost(request, allowedHosts)) return json({ error: 'Host is not allowed' }, 403)
    if (url.pathname === '/healthz' && request.method === 'GET') return json({ status: 'ok' })
    if (url.pathname === oauthRoutes.start && request.method === 'GET') return oauth.handleStart(url)
    if (url.pathname === oauthRoutes.callback && request.method === 'GET') return oauth.handleCallback(request)
    if (url.pathname !== '/mcp' && url.pathname !== '/internal/discovery/connect') return json({ error: 'Not found' }, 404)
    const caller = await verify(request)
    if (!caller) return json({ error: 'Invalid or missing bearer token' }, 401, { 'www-authenticate': 'Bearer' })
    if (url.pathname === '/internal/discovery/connect') {
      if (!caller.discovery || request.method !== 'POST') return json({ error: 'Discovery authorization required' }, 403)
      const limited = enforceRateLimit(rateLimiter, caller.subject, request.headers.get('mcp-session-id'), 'tool')
      if (limited) return limited
      try {
        if (await oauth.isConnected(discoverySubject)) {
          await oauth.accessToken(discoverySubject)
          return json({ connected: true })
        }
        return json({ connected: false, authorizeUrl: await oauth.beginConnect(discoverySubject) })
      } catch {
        console.error('Home Assistant discovery grant check failed; upstream details were redacted')
        return json({ error: 'Home Assistant discovery grant is unavailable; check adapter logs' }, 503)
      }
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    // Unlike interactive provider routes, this raw proxy is gateway-to-server only; browser MCP calls are never accepted.
    if (request.headers.has('origin')) return json({ error: 'Browser origins are not allowed for MCP requests' }, 403)
    let message: JsonRpcMessage
    try { message = JSON.parse((await readBounded(request.body, maxRequestBytes)).toString('utf8')) as JsonRpcMessage } catch {
      return json({ error: 'Invalid or oversized JSON-RPC request' }, 400)
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return json({ error: 'Invalid JSON-RPC request' }, 400)
    }
    if (message.method !== 'notifications/initialized' && !((typeof message.id === 'number' && Number.isFinite(message.id)) || typeof message.id === 'string')) {
      return json({ error: 'JSON-RPC request id is required' }, 400)
    }
    const category = message.method === 'tools/call' ? 'tool' : DISCOVERY_METHODS.has(message.method) ? 'discovery' : 'other'
    const limited = enforceRateLimit(rateLimiter, caller.subject, request.headers.get('mcp-session-id'), category)
    if (limited) return limited
    if (caller.discovery && !DISCOVERY_METHODS.has(message.method)) return json({ error: 'Discovery credentials cannot invoke this MCP method' }, 403)
    if (!caller.discovery && message.method === 'tools/call') {
      const name = record(message.params) ? message.params.name : undefined
      if (name === 'connect_home_assistant' || name === 'disconnect_home_assistant') {
        if (!validManagedToolCall(message.params)) return rpcError(message.id, -32602, 'Invalid managed tool arguments')
      }
      if (name === 'connect_home_assistant') {
        return toolResult(message.id, await oauth.isConnected(caller.subject)
          ? { connected: true }
          : { connected: false, authorizeUrl: await oauth.beginConnect(caller.subject), validForMinutes: 10 })
      }
      if (name === 'disconnect_home_assistant') return toolResult(message.id, { disconnected: await oauth.disconnect(caller.subject) })
    }
    try {
      const useDiscovery = DISCOVERY_METHODS.has(message.method)
      const token = await oauth.accessToken(useDiscovery ? discoverySubject : caller.subject)
      if (!token) {
        if (useDiscovery) return json({ error: 'Home Assistant discovery identity has not been connected' }, 503)
        return toolResult(message.id, `Home Assistant is not connected for you. Open this link, sign in with your Keycloak account, and retry: ${await oauth.beginConnect(caller.subject)}`, true)
      }
      const sessionId = request.headers.get('mcp-session-id')
      const response = await forward(message, token, sessionId, `${useDiscovery ? 'discovery' : 'user'}:${caller.subject}`)
      if (message.method !== 'tools/list' || response.status !== 200) return response
      const responseSession = response.headers.get('mcp-session-id')
      const body = await response.text()
      const eventData = body.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
      const data = JSON.parse(eventData || body) as { result?: { tools?: Array<{ name?: string }> } }
      if (!Array.isArray(data.result?.tools)) throw new Error('Home Assistant returned an invalid tool list')
      if (data.result.tools.some((tool) => manageTools.some((managed) => managed.name === tool.name))) throw new Error('Home Assistant tool name conflicts with the adapter')
      data.result.tools.push(...manageTools)
      return json(data, 200, responseSession ? { 'mcp-session-id': responseSession } : {})
    } catch {
      console.error('Home Assistant MCP request failed; upstream details were redacted')
      return json({ error: 'Home Assistant MCP request failed; check adapter logs' }, 502)
    }
  }
}

