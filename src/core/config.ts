import { parseServiceUrl } from './config-util.js'

export type Transport = 'http' | 'stdio'

export interface OidcAuthConfig {
  mode: 'oidc'
  issuer: URL
  audience: string
  additionalAudiences?: readonly string[]
  resource: URL
  roleClientId?: string
  requiredRealmRole?: string
  requiredGroup?: string
  requiredRole: string
  discoveryClientId?: string
}

export type HttpAuthConfig =
  | { mode: 'none' }
  | { mode: 'static'; clientTokens: ReadonlyMap<string, string> }
  | OidcAuthConfig

export interface CoreConfig {
  transport: Transport
  http: {
    host: string
    port: number
    allowedHosts: ReadonlySet<string>
    allowedOrigins: ReadonlySet<string>
    auth: HttpAuthConfig
  }
}

function parseList(value: string | undefined, fallback: string[] = []): ReadonlySet<string> {
  return new Set((value ? value.split(',') : fallback).map((item) => item.trim()).filter(Boolean))
}

function parseClientTokens(value: string | undefined, transport: Transport): ReadonlyMap<string, string> {
  if (transport === 'stdio') return new Map()
  if (!value) throw new Error('MCP_CLIENT_TOKENS is required for HTTP transport')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP_CLIENT_TOKENS must be a JSON object mapping client IDs to tokens')
  }
  const tokens = new Map<string, string>()
  for (const [clientId, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (!clientId || typeof token !== 'string' || token.length < 16) {
      throw new Error('Each MCP client token must be a string of at least 16 characters')
    }
    if ([...tokens.values()].includes(token)) throw new Error('MCP client tokens must be unique')
    tokens.set(clientId, token)
  }
  if (tokens.size === 0) throw new Error('MCP_CLIENT_TOKENS must contain at least one client')
  return tokens
}

function parseOidcUrl(name: string, value: string | undefined, allowInsecureHttp: boolean): URL {
  if (!value) throw new Error(`${name} is required when ENABLE_OIDC=true`)
  return parseServiceUrl(name, value, allowInsecureHttp)
}

function parseHttpAuth(env: NodeJS.ProcessEnv, transport: Transport): HttpAuthConfig {
  if (env.ENABLE_OIDC !== undefined && !['true', 'false'].includes(env.ENABLE_OIDC)) {
    throw new Error('ENABLE_OIDC must be true or false')
  }
  if (env.ENABLE_OIDC === 'false') return { mode: 'none' }
  if (env.ENABLE_OIDC === 'true' && env.MCP_AUTH_MODE && env.MCP_AUTH_MODE !== 'oidc') {
    throw new Error('ENABLE_OIDC=true conflicts with MCP_AUTH_MODE')
  }
  const useOidc = env.ENABLE_OIDC === 'true' || env.MCP_AUTH_MODE === 'oidc'
  if (!useOidc) return { mode: 'static', clientTokens: parseClientTokens(env.MCP_CLIENT_TOKENS, transport) }
  const allowInsecureHttp = env.MCP_OIDC_ALLOW_INSECURE_HTTP === 'true'
  const issuer = parseOidcUrl('MCP_OIDC_ISSUER', env.MCP_OIDC_ISSUER, allowInsecureHttp)
  const resource = parseOidcUrl('MCP_OIDC_RESOURCE', env.MCP_OIDC_RESOURCE, allowInsecureHttp)
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
    ...(env.MCP_OIDC_REQUIRED_GROUP ? { requiredGroup: env.MCP_OIDC_REQUIRED_GROUP } : {}),
    requiredRole: env.MCP_OIDC_REQUIRED_ROLE ?? 'mcp-user'
  }
}

export function loadCoreConfig(env: NodeJS.ProcessEnv): CoreConfig {
  const transport: Transport = env.MCP_TRANSPORT === 'stdio' ? 'stdio' : 'http'
  const port = Number(env.MCP_PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP_PORT is invalid')
  return {
    transport,
    http: {
      host: env.MCP_HOST ?? '0.0.0.0',
      port,
      allowedHosts: parseList(env.MCP_ALLOWED_HOSTS, ['localhost', '127.0.0.1', '::1']),
      allowedOrigins: parseList(env.MCP_ALLOWED_ORIGINS),
      auth: parseHttpAuth(env, transport)
    }
  }
}

