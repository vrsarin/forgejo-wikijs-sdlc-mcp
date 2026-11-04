import { toNodeHandler } from '@modelcontextprotocol/node'
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthInfo,
  type McpHttpHandler,
  type McpServer,
  type OAuthMetadata
} from '@modelcontextprotocol/server'
import { OidcJwtVerifier } from './auth.js'
import type { HttpAuthConfig } from './config.js'
import { DISCOVERY_METHODS, discoveryRequestAllowed } from './discovery-access.js'
import type { ProviderDefinition } from './provider.js'
import { createMcpHttpServer, installShutdown, tlsFilesFromEnvironment } from './tls-http.js'
import { timingSafeStringEqual } from './security.js'
import { isAllowedHost } from './http-util.js'
import { enforceRateLimit, FixedWindowRateLimiter } from './rate-limit.js'
import { readBounded } from './read-bounded.js'

const MAX_MCP_REQUEST_BYTES = 4 * 1024 * 1024
type RequestCategory = 'discovery' | 'tool' | 'other'

export async function classifyMcpRequest(request: Request): Promise<RequestCategory> {
  if (request.method !== 'POST' || !request.body) return 'other'
  let raw: Buffer
  try {
    raw = await readBounded(request.clone().body, MAX_MCP_REQUEST_BYTES)
  } catch {
    throw new RangeError('MCP request exceeds the supported size limit')
  }
  const body = JSON.parse(raw.toString('utf8')) as { method?: unknown }
  if (typeof body?.method !== 'string') return 'other'
  return body.method === 'tools/call' ? 'tool' : DISCOVERY_METHODS.has(body.method) ? 'discovery' : 'other'
}

export interface HttpServerOptions {
  host: string
  port: number
  allowedHosts: ReadonlySet<string>
  allowedOrigins: ReadonlySet<string>
  auth: HttpAuthConfig
}

function response(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function validateRequestBoundary(request: Request, options: HttpServerOptions): Response | undefined {
  if (!isAllowedHost(request, options.allowedHosts)) return response(403, 'Host is not allowed')
  const origin = request.headers.get('origin')
  if (origin && !options.allowedOrigins.has(origin)) return response(403, 'Origin is not allowed')
  return undefined
}

export async function authorizeRequest(request: Request, options: HttpServerOptions): Promise<AuthInfo | Response> {
  const boundaryFailure = validateRequestBoundary(request, options)
  if (boundaryFailure) return boundaryFailure
  if (options.auth.mode === 'none') {
    return { token: '', clientId: 'development-anonymous', scopes: [] }
  }
  if (options.auth.mode === 'oidc') {
    return requireBearerAuth({
      verifier: new OidcJwtVerifier(options.auth),
      expectedResource: options.auth.resource,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(options.auth.resource)
    })(request)
  }
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return response(401, 'Bearer token required', { 'www-authenticate': 'Bearer' })
  const presented = authorization.slice('Bearer '.length)
  for (const [clientId, token] of options.auth.clientTokens) {
    if (timingSafeStringEqual(presented, token)) return { token: presented, clientId, scopes: ['mcp'] }
  }
  return response(401, 'Invalid bearer token', { 'www-authenticate': 'Bearer error="invalid_token"' })
}

function keycloakMetadata(issuer: URL): OAuthMetadata {
  const base = issuer.toString().replace(/\/$/, '')
  return {
    issuer: base,
    authorization_endpoint: `${base}/protocol/openid-connect/auth`,
    token_endpoint: `${base}/protocol/openid-connect/token`,
    jwks_uri: `${base}/protocol/openid-connect/certs`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none']
  }
}

/** Unauthenticated browser routes (the OAuth redirect legs); return undefined for any other request. */
export type BrowserRoutes = (request: Request) => Promise<Response | undefined>

export async function serveHttp(provider: ProviderDefinition, factory: () => McpServer, options: HttpServerOptions, browserRoutes?: BrowserRoutes): Promise<void> {
  if (options.auth.mode === 'none') {
    console.error(`WARNING: ${provider.displayName} MCP authentication is disabled; use only in an isolated development environment`)
  }
  const handler = createMcpHandler(factory)
  const rateLimiter = new FixedWindowRateLimiter()
  const oidc = options.auth.mode === 'oidc' ? options.auth : undefined
  const oidcGate = oidc ? requireBearerAuth({
    verifier: new OidcJwtVerifier(oidc), expectedResource: oidc.resource,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(oidc.resource)
  }) : undefined
  const metadataOptions = oidc ? {
    oauthMetadata: keycloakMetadata(oidc.issuer),
    resourceServerUrl: oidc.resource,
    scopesSupported: ['openid', 'profile', 'email'],
    resourceName: provider.resourceName,
    dangerouslyAllowInsecureIssuerUrl: oidc.issuer.protocol === 'http:'
  } : undefined
  const securedHandler: McpHttpHandler = {
    ...handler,
    fetch: async (request) => {
      const boundaryFailure = validateRequestBoundary(request, options)
      if (boundaryFailure) return boundaryFailure
      const browser = await browserRoutes?.(request)
      if (browser) return browser
      if (metadataOptions) {
        const metadata = oauthMetadataResponse(request, metadataOptions)
        if (metadata) return metadata
      }
      if (new URL(request.url).pathname !== '/mcp') return response(404, 'not found')
      const auth = oidcGate ? await oidcGate(request) : await authorizeRequest(request, options)
      if (auth instanceof Response) return auth
      let category: RequestCategory
      try {
        category = await classifyMcpRequest(request)
      } catch (error) {
        return response(error instanceof RangeError ? 413 : 400, error instanceof RangeError ? 'request body is too large' : 'request body is not valid JSON')
      }
      const identity =
        typeof auth.extra?.subject === 'string' && auth.extra.subject.length > 0
          ? auth.extra.subject
          : auth.clientId
      const limited = enforceRateLimit(rateLimiter, identity, request.headers.get('mcp-session-id'), category)
      if (limited) return limited
      if (auth.extra?.discovery === true && !await discoveryRequestAllowed(request)) {
        return response(403, 'Discovery credentials cannot invoke this MCP method')
      }
      return handler.fetch(request, { authInfo: auth })
    }
  }
  const nodeHandler = toNodeHandler(securedHandler)
  const tls = tlsFilesFromEnvironment(process.env)
  const httpServer = createMcpHttpServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok"}')
      return
    }
    void nodeHandler(request as Parameters<typeof nodeHandler>[0], response as Parameters<typeof nodeHandler>[1])
  }, tls)
  installShutdown(httpServer, () => handler.close())
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port, options.host, resolve)
  })
  console.error(`${provider.runtimeName} MCP listening on ${tls ? 'https' : 'http'}://${options.host}:${options.port}/mcp`)
}
