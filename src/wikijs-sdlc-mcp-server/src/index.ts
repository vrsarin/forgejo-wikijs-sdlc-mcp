import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { loadConfig } from './config.js'
import { serveHttp, type BrowserRoutes } from './http.js'
import { EncryptedFileStore } from './oauth/store.js'
import { OAUTH_CALLBACK_PATH, OAUTH_START_PATH, WikiJsOAuth } from './oauth/wikijs-oauth.js'
import { WikiJsLoginFlow } from './oauth/login-flow.js'
import { beginWikiSso } from './oauth/wiki-sso.js'
import { WikiJsClient } from './providers/wikijs.js'
import { createWikiJsSdlcServer } from './server.js'

const config = loadConfig()
const wikiJs = config.wikiJsMcpUrl ? new WikiJsClient({ mcpUrl: config.wikiJsMcpUrl }) : undefined
const oauth = config.wikiJsOAuth && config.wikiJsMcpUrl
  ? new WikiJsOAuth({ wikiOrigin: config.wikiJsMcpUrl, redirectUrl: config.wikiJsOAuth.redirectUrl, scopes: config.wikiJsOAuth.scopes, store: new EncryptedFileStore(config.wikiJsOAuth.storePath, config.wikiJsOAuth.encryptionKey) })
  : undefined
const login = oauth && config.wikiJsLoginClientId && config.http.auth.mode === 'oidc'
  ? new WikiJsLoginFlow({
      issuer: config.http.auth.issuer, resource: config.http.auth.resource, clientId: config.wikiJsLoginClientId,
      callbackUrl: new URL('/oauth/wikijs/login/callback', config.wikiJsOAuth!.redirectUrl.origin), wikiJs: oauth
    })
  : undefined
const factory = () => createWikiJsSdlcServer(config.wikiJsMcpUrl, wikiJs, oauth, config.wikiJsToken)
const browserRoutes: BrowserRoutes = async (request) => {
  const url = new URL(request.url)
  if (request.method !== 'GET') return undefined
  if (config.http.auth.mode === 'oidc' && url.pathname === `${config.http.auth.issuer.pathname.replace(/\/$/, '')}/protocol/openid-connect/auth`) {
    return login ? login.start(request) : new Response('Wiki.js sign-in is not configured.', { status: 503 })
  }
  if (url.pathname === '/oauth/wikijs/login/start') return login?.startBrowser(request)
  if (url.pathname === '/oauth/wikijs/login/callback') return login?.callback(request)
  if (url.pathname === '/_authorize' && login && config.wikiJsOAuth && config.wikiJsMcpUrl) {
    return beginWikiSso(request, { wikiUrl: config.wikiJsMcpUrl, callbackUrl: config.wikiJsOAuth.redirectUrl })
  }
  if (url.pathname === OAUTH_START_PATH) return oauth?.handleStart(url)
  if (url.pathname === OAUTH_CALLBACK_PATH && oauth) {
    const response = await oauth.handleCallback(request)
    return login ? login.finishProvider(request, response) : response
  }
  return undefined
}

if (config.transport === 'stdio') {
  void serveStdio(factory)
  console.error('wikijs_sdlc MCP running on stdio')
} else {
  await serveHttp(factory, config.http, browserRoutes)
}
