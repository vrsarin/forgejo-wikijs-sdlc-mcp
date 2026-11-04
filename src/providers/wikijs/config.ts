import { loadCoreConfig, type CoreConfig } from '../../core/config.js'
import { parseEncryptionKey, parseRedirectUrl, parseServiceUrl } from '../../core/config-util.js'
import { oauthPaths } from '../../core/provider.js'
import { definition } from './definition.js'

export type { HttpAuthConfig } from '../../core/config.js'

export interface ServerConfig extends CoreConfig {
  wikiJsMcpUrl?: URL
  /** Shared provider token used only by the single-user stdio development transport. */
  wikiJsToken?: string
  /** Present when users can connect Wiki.js through OAuth instead of supplying a token. */
  providerOAuth?: { redirectUrl: URL; scopes: string; storePath: string; encryptionKey: Buffer }
  wikiJsLoginClientId?: string
}

function parseWikiUrl(value: string | undefined, allowInsecureHttp: boolean): URL | undefined {
  if (!value) return undefined
  const url = parseServiceUrl('WIKIJS_MCP_URL', value, allowInsecureHttp)
  if (!url.pathname.endsWith('/_mcp')) throw new Error('WIKIJS_MCP_URL must end with /_mcp')
  return url
}

function parseOAuth(env: NodeJS.ProcessEnv, wikiJsMcpUrl: URL | undefined): ServerConfig['providerOAuth'] {
  if (!env.WIKIJS_OAUTH_REDIRECT_URL) return undefined
  if (!wikiJsMcpUrl) throw new Error('WIKIJS_OAUTH_REDIRECT_URL requires WIKIJS_MCP_URL')
  const redirectUrl = parseRedirectUrl('WIKIJS_OAUTH_REDIRECT_URL', env.WIKIJS_OAUTH_REDIRECT_URL, oauthPaths(definition).callback)
  const key = parseEncryptionKey(env, 'WIKIJS_TOKEN_ENCRYPTION_KEY')
  return { redirectUrl, scopes: env.WIKIJS_OAUTH_SCOPES ?? 'mcp:read pages:read glossary:read', storePath: env.WIKIJS_TOKEN_STORE_PATH ?? '/data/wikijs-grants.enc', encryptionKey: key }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const core = loadCoreConfig(env)
  const { transport } = core
  const wikiJsMcpUrl = parseWikiUrl(env.WIKIJS_MCP_URL, env.WIKIJS_ALLOW_INSECURE_MCP_HTTP === 'true')
  if (transport === 'stdio' && wikiJsMcpUrl && !env.WIKIJS_ACCESS_TOKEN) {
    throw new Error('WIKIJS_ACCESS_TOKEN is required for stdio transport when WIKIJS_MCP_URL is configured')
  }
  const oauth = parseOAuth(env, wikiJsMcpUrl)
  return {
    ...core,
    ...(wikiJsMcpUrl ? { wikiJsMcpUrl } : {}),
    ...(transport === 'stdio' && env.WIKIJS_ACCESS_TOKEN ? { wikiJsToken: env.WIKIJS_ACCESS_TOKEN } : {}),
    ...(oauth ? { providerOAuth: oauth } : {}),
    ...(env.WIKIJS_MCP_LOGIN_CLIENT_ID ? { wikiJsLoginClientId: env.WIKIJS_MCP_LOGIN_CLIENT_ID } : {})
  }
}
