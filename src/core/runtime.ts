import { serveStdio } from '@modelcontextprotocol/server/stdio'
import type { McpServer } from '@modelcontextprotocol/server'
import type { CoreConfig } from './config.js'
import { serveHttp, type BrowserRoutes } from './http.js'
import { KeycloakLoginFlow, type ProviderLoginFlow } from './login-flow.js'
import { oauthPaths, type ProviderDefinition } from './provider.js'

interface LoginOAuth {
  accessToken(subject: string): Promise<string | undefined>
  beginConnect(subject: string, reuse: boolean): Promise<string>
}

export function buildLoginFlow(provider: ProviderDefinition, config: CoreConfig, clientId: string | undefined, oauth: LoginOAuth | undefined, redirectUrl: URL | undefined): KeycloakLoginFlow | undefined {
  if (!clientId || !oauth || !redirectUrl || config.http.auth.mode !== 'oidc') return undefined
  return new KeycloakLoginFlow(provider, {
    issuer: config.http.auth.issuer, resource: config.http.auth.resource, clientId,
    callbackUrl: new URL(oauthPaths(provider).loginCallback, redirectUrl.origin), provider: oauth
  })
}

interface OAuthRoutes {
  handleStart(url: URL): Promise<Response> | Response
  handleCallback(request: Request): Promise<Response>
}

export function buildBrowserRoutes(options: {
  provider: ProviderDefinition
  config: CoreConfig
  login?: ProviderLoginFlow
  oauth?: OAuthRoutes
  extra?: BrowserRoutes
}): BrowserRoutes {
  const { provider, config, login, oauth, extra } = options
  const paths = oauthPaths(provider)
  return async (request) => {
    const url = new URL(request.url)
    if (request.method !== 'GET') return undefined
    if (config.http.auth.mode === 'oidc' && url.pathname === `${config.http.auth.issuer.pathname.replace(/\/$/, '')}/protocol/openid-connect/auth`) {
      return login ? login.start(request) : new Response(`${provider.displayName} sign-in is not configured.`, { status: 503 })
    }
    if (url.pathname === paths.loginStart) return login?.startBrowser(request)
    if (url.pathname === paths.loginCallback) return login?.callback(request)
    const additional = await extra?.(request)
    if (additional) return additional
    if (url.pathname === paths.start) return oauth?.handleStart(url)
    if (url.pathname === paths.callback && oauth) {
      const response = await oauth.handleCallback(request)
      return login ? login.finishProvider(request, response) : response
    }
    return undefined
  }
}

export async function runTransport(
  provider: ProviderDefinition,
  config: CoreConfig,
  factory: () => McpServer,
  browserRoutes: BrowserRoutes
): Promise<void> {
  if (config.transport === 'stdio') {
    void serveStdio(factory)
    console.error(`${provider.runtimeName} MCP running on stdio`)
    return
  }
  await serveHttp(provider, factory, config.http, browserRoutes)
}
