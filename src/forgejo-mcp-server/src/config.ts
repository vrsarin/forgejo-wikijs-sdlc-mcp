import type { OidcAuthConfig } from './auth.js'

export type HttpAuthConfig =
  | { mode: 'none' }
  | { mode: 'static'; clientTokens: ReadonlyMap<string, string> }
  | OidcAuthConfig

export interface ForgejoOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUrl: URL
  publicUrl: URL
  storePath: string
  encryptionKey: Buffer
}

export interface ServerConfig {
  transport: 'http' | 'stdio'
  writesEnabled: boolean
  http: {
    host: string
    port: number
    allowedHosts: ReadonlySet<string>
    allowedOrigins: ReadonlySet<string>
    auth: HttpAuthConfig
  }
  forgejo: {
    baseUrl: URL
    token: string | undefined
    allowedRepositories: ReadonlySet<string>
    requestTimeoutMs: number
  }
  /** Present when users can connect Forgejo through OAuth instead of supplying a token. */
  forgejoOAuth?: ForgejoOAuthConfig
  /** Public Keycloak client used to identify the user before the MCP authorization completes. */
  forgejoLoginClientId?: string
}

function parseBaseUrl(value: string, allowInsecureHttp: boolean): URL {
  const url = new URL(value)
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
    url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || allowInsecureHttp))) {
    throw new Error('FORGEJO_URL must use HTTPS unless insecure provider HTTP is explicitly enabled')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('FORGEJO_URL must not contain credentials, query parameters, or a fragment')
  }
  url.pathname = url.pathname.replace(/\/$/, '')
  return url
}

function parseAllowedRepositories(value: string | undefined): ReadonlySet<string> {
  const repositories = (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  for (const repository of repositories) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(`Invalid repository in SDLC_ALLOWED_REPOSITORIES: ${repository}`)
    }
  }
  return new Set(repositories)
}

function parseList(value: string | undefined, fallback: string[] = []): ReadonlySet<string> {
  return new Set((value ? value.split(',') : fallback).map((item) => item.trim()).filter(Boolean))
}

function parseClientTokens(value: string | undefined, transport: 'http' | 'stdio'): ReadonlyMap<string, string> {
  if (transport === 'stdio') return new Map()
  if (!value) throw new Error('MCP_CLIENT_TOKENS is required for HTTP transport')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP_CLIENT_TOKENS must be a JSON object mapping client IDs to tokens')
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) throw new Error('MCP_CLIENT_TOKENS must contain at least one client')
  const tokens = new Map<string, string>()
  for (const [clientId, token] of entries) {
    if (!clientId || typeof token !== 'string' || token.length < 16) {
      throw new Error('Each MCP client token must be a string of at least 16 characters')
    }
    if ([...tokens.values()].includes(token)) throw new Error('MCP client tokens must be unique')
    tokens.set(clientId, token)
  }
  return tokens
}

function parseOidcUrl(name: string, value: string | undefined, allowInsecureHttp: boolean): URL {
  if (!value) throw new Error(`${name} is required when ENABLE_OIDC=true`)
  const url = new URL(value)
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || allowInsecureHttp))) {
    throw new Error(`${name} must use HTTPS unless insecure OIDC HTTP is explicitly enabled`)
  }
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} contains unsupported URL components`)
  return url
}

function parseHttpAuth(env: NodeJS.ProcessEnv, transport: 'http' | 'stdio'): HttpAuthConfig {
  if (env.ENABLE_OIDC !== undefined && !['true', 'false'].includes(env.ENABLE_OIDC)) {
    throw new Error('ENABLE_OIDC must be true or false')
  }
  if (env.ENABLE_OIDC === 'false') return { mode: 'none' }
  if (env.ENABLE_OIDC === 'true' && env.MCP_AUTH_MODE && env.MCP_AUTH_MODE !== 'oidc') {
    throw new Error('ENABLE_OIDC=true conflicts with MCP_AUTH_MODE')
  }
  const useOidc = env.ENABLE_OIDC === 'true' || env.MCP_AUTH_MODE === 'oidc'
  if (!useOidc) return { mode: 'static', clientTokens: parseClientTokens(env.MCP_CLIENT_TOKENS, transport) }
  const issuer = parseOidcUrl('MCP_OIDC_ISSUER', env.MCP_OIDC_ISSUER, env.MCP_OIDC_ALLOW_INSECURE_HTTP === 'true')
  const resource = parseOidcUrl('MCP_OIDC_RESOURCE', env.MCP_OIDC_RESOURCE, env.MCP_OIDC_ALLOW_INSECURE_HTTP === 'true')
  if (!env.MCP_OIDC_AUDIENCE) throw new Error('MCP_OIDC_AUDIENCE is required when ENABLE_OIDC=true')
  if (!env.MCP_OIDC_ROLE_CLIENT_ID && !env.MCP_OIDC_REQUIRED_REALM_ROLE) {
    throw new Error('MCP_OIDC_ROLE_CLIENT_ID or MCP_OIDC_REQUIRED_REALM_ROLE is required when ENABLE_OIDC=true')
  }
  if (env.MCP_OIDC_ROLE_CLIENT_ID && env.MCP_OIDC_REQUIRED_REALM_ROLE) {
    throw new Error('Configure only one OIDC role source')
  }
  const additionalAudiences = env.MCP_OIDC_ADDITIONAL_AUDIENCES?.split(',').map((value) => value.trim()) ?? []
  if (additionalAudiences.some((value) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value))) {
    throw new Error('MCP_OIDC_ADDITIONAL_AUDIENCES must contain nonempty Keycloak client IDs')
  }
  return {
    mode: 'oidc', issuer, resource,
    audience: env.MCP_OIDC_AUDIENCE,
    ...(additionalAudiences.length ? { additionalAudiences } : {}),
    ...(env.MCP_OIDC_DISCOVERY_CLIENT_ID ? { discoveryClientId: env.MCP_OIDC_DISCOVERY_CLIENT_ID } : {}),
    ...(env.MCP_OIDC_ROLE_CLIENT_ID ? { roleClientId: env.MCP_OIDC_ROLE_CLIENT_ID } : {}),
    ...(env.MCP_OIDC_REQUIRED_REALM_ROLE ? { requiredRealmRole: env.MCP_OIDC_REQUIRED_REALM_ROLE } : {}),
    requiredRole: env.MCP_OIDC_REQUIRED_ROLE ?? 'mcp-user'
  }
}

function parseOAuth(env: NodeJS.ProcessEnv, baseUrl: URL): ForgejoOAuthConfig | undefined {
  if (!env.FORGEJO_OAUTH_CLIENT_ID) return undefined
  if (!env.FORGEJO_OAUTH_CLIENT_SECRET) throw new Error('FORGEJO_OAUTH_CLIENT_SECRET is required with FORGEJO_OAUTH_CLIENT_ID')
  const redirectUrl = new URL(env.FORGEJO_OAUTH_REDIRECT_URL ?? '')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(redirectUrl.hostname)
  if (redirectUrl.protocol !== 'https:' && !(redirectUrl.protocol === 'http:' && loopback)) throw new Error('FORGEJO_OAUTH_REDIRECT_URL must be https, or http on localhost/127.0.0.1/[::1]')
  if (redirectUrl.pathname !== '/oauth/forgejo/callback' || redirectUrl.search || redirectUrl.hash || redirectUrl.username) throw new Error('FORGEJO_OAUTH_REDIRECT_URL must end with /oauth/forgejo/callback and carry no query, fragment, or credentials')
  const key = Buffer.from(env.FORGEJO_TOKEN_ENCRYPTION_KEY ?? '', 'base64')
  if (key.length !== 32) throw new Error('FORGEJO_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)')
  const publicUrl = env.FORGEJO_PUBLIC_URL ? parseBaseUrl(env.FORGEJO_PUBLIC_URL, env.FORGEJO_ALLOW_INSECURE_HTTP === 'true') : baseUrl
  return { clientId: env.FORGEJO_OAUTH_CLIENT_ID, clientSecret: env.FORGEJO_OAUTH_CLIENT_SECRET, redirectUrl, publicUrl, storePath: env.FORGEJO_TOKEN_STORE_PATH ?? '/data/forgejo-grants.enc', encryptionKey: key }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (!env.FORGEJO_URL) throw new Error('FORGEJO_URL is required')
  const transport = env.MCP_TRANSPORT === 'stdio' ? 'stdio' : 'http'
  // Over HTTP every caller brings their own Forgejo token; the shared one exists only for local stdio use.
  if (transport === 'stdio' && !env.FORGEJO_ACCESS_TOKEN) throw new Error('FORGEJO_ACCESS_TOKEN is required for stdio transport')
  const port = Number(env.MCP_PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP_PORT is invalid')
  const baseUrl = parseBaseUrl(env.FORGEJO_URL, env.FORGEJO_ALLOW_INSECURE_HTTP === 'true')
  const forgejoOAuth = parseOAuth(env, baseUrl)
  return {
    transport,
    writesEnabled: env.SDLC_ENABLE_WRITES === 'true',
    http: {
      host: env.MCP_HOST ?? '0.0.0.0',
      port,
      allowedHosts: parseList(env.MCP_ALLOWED_HOSTS, ['localhost', '127.0.0.1', '::1']),
      allowedOrigins: parseList(env.MCP_ALLOWED_ORIGINS),
      auth: parseHttpAuth(env, transport)
    },
    forgejo: {
      baseUrl,
      token: transport === 'stdio' ? env.FORGEJO_ACCESS_TOKEN : undefined,
      allowedRepositories: parseAllowedRepositories(env.SDLC_ALLOWED_REPOSITORIES),
      requestTimeoutMs: 10_000
    },
    ...(forgejoOAuth ? { forgejoOAuth } : {}),
    ...(env.FORGEJO_MCP_LOGIN_CLIENT_ID ? { forgejoLoginClientId: env.FORGEJO_MCP_LOGIN_CLIENT_ID } : {})
  }
}
