import { loadCoreConfig, type CoreConfig } from '../../core/config.js'
import { parseEncryptionKey, parseRedirectUrl, parseServiceUrl } from '../../core/config-util.js'
import { oauthPaths } from '../../core/provider.js'
import { definition } from './definition.js'

export type { HttpAuthConfig } from '../../core/config.js'

export interface ProviderOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUrl: URL
  publicUrl: URL
  storePath: string
  encryptionKey: Buffer
}

export interface ServerConfig extends CoreConfig {
  writesEnabled: boolean
  forgejo: {
    baseUrl: URL
    token: string | undefined
    allowedRepositories: ReadonlySet<string>
    requestTimeoutMs: number
  }
  /** Present when users can connect Forgejo through OAuth instead of supplying a token. */
  providerOAuth?: ProviderOAuthConfig
  /** Public Keycloak client used to identify the user before the MCP authorization completes. */
  forgejoLoginClientId?: string
}

function parseBaseUrl(value: string, allowInsecureHttp: boolean): URL {
  const url = parseServiceUrl('FORGEJO_URL', value, allowInsecureHttp)
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

function parseOAuth(env: NodeJS.ProcessEnv, baseUrl: URL): ProviderOAuthConfig | undefined {
  if (!env.FORGEJO_OAUTH_CLIENT_ID) return undefined
  if (!env.FORGEJO_OAUTH_CLIENT_SECRET) throw new Error('FORGEJO_OAUTH_CLIENT_SECRET is required with FORGEJO_OAUTH_CLIENT_ID')
  const redirectUrl = parseRedirectUrl('FORGEJO_OAUTH_REDIRECT_URL', env.FORGEJO_OAUTH_REDIRECT_URL, oauthPaths(definition).callback)
  const key = parseEncryptionKey(env, 'FORGEJO_TOKEN_ENCRYPTION_KEY')
  const publicUrl = env.FORGEJO_PUBLIC_URL ? parseBaseUrl(env.FORGEJO_PUBLIC_URL, env.FORGEJO_ALLOW_INSECURE_HTTP === 'true') : baseUrl
  return { clientId: env.FORGEJO_OAUTH_CLIENT_ID, clientSecret: env.FORGEJO_OAUTH_CLIENT_SECRET, redirectUrl, publicUrl, storePath: env.FORGEJO_TOKEN_STORE_PATH ?? '/data/forgejo-grants.enc', encryptionKey: key }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (!env.FORGEJO_URL) throw new Error('FORGEJO_URL is required')
  const core = loadCoreConfig(env)
  const { transport } = core
  // Over HTTP every caller brings their own Forgejo token; the shared one exists only for local stdio use.
  if (transport === 'stdio' && !env.FORGEJO_ACCESS_TOKEN) throw new Error('FORGEJO_ACCESS_TOKEN is required for stdio transport')
  const baseUrl = parseBaseUrl(env.FORGEJO_URL, env.FORGEJO_ALLOW_INSECURE_HTTP === 'true')
  const providerOAuth = parseOAuth(env, baseUrl)
  return {
    ...core,
    writesEnabled: env.SDLC_ENABLE_WRITES === 'true',
    forgejo: {
      baseUrl,
      token: transport === 'stdio' ? env.FORGEJO_ACCESS_TOKEN : undefined,
      allowedRepositories: parseAllowedRepositories(env.SDLC_ALLOWED_REPOSITORIES),
      requestTimeoutMs: 10_000
    },
    ...(providerOAuth ? { providerOAuth } : {}),
    ...(env.FORGEJO_MCP_LOGIN_CLIENT_ID ? { forgejoLoginClientId: env.FORGEJO_MCP_LOGIN_CLIENT_ID } : {})
  }
}
