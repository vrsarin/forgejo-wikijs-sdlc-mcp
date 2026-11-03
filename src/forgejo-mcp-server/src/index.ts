import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { loadConfig } from './config.js'
import { serveHttp, type BrowserRoutes } from './http.js'
import { ForgejoOAuth, OAUTH_CALLBACK_PATH, OAUTH_START_PATH } from './oauth/forgejo-oauth.js'
import { ForgejoLoginFlow } from './oauth/login-flow.js'
import { EncryptedFileStore } from './oauth/store.js'
import { ForgejoClient } from './providers/forgejo.js'
import { createForgejoServer } from './server.js'

const config = loadConfig()
const forgejo = new ForgejoClient(config.forgejo)
const oauth = config.forgejoOAuth
  ? new ForgejoOAuth({ publicUrl: config.forgejoOAuth.publicUrl, internalUrl: config.forgejo.baseUrl, redirectUrl: config.forgejoOAuth.redirectUrl, clientId: config.forgejoOAuth.clientId, clientSecret: config.forgejoOAuth.clientSecret, store: new EncryptedFileStore(config.forgejoOAuth.storePath, config.forgejoOAuth.encryptionKey) })
  : undefined
const login = oauth && config.forgejoLoginClientId && config.http.auth.mode === 'oidc'
  ? new ForgejoLoginFlow({
      issuer: config.http.auth.issuer, resource: config.http.auth.resource, clientId: config.forgejoLoginClientId,
      callbackUrl: new URL('/oauth/forgejo/login/callback', config.forgejoOAuth!.redirectUrl.origin), forgejo: oauth
    })
  : undefined
const factory = () => createForgejoServer(forgejo, config.writesEnabled, config.transport === 'http', oauth)
const browserRoutes: BrowserRoutes = async (request) => {
  const url = new URL(request.url)
  if (request.method !== 'GET') return undefined
  if (config.http.auth.mode === 'oidc' && url.pathname === `${config.http.auth.issuer.pathname.replace(/\/$/, '')}/protocol/openid-connect/auth`) {
    return login ? login.start(request) : new Response('Forgejo sign-in is not configured.', { status: 503 })
  }
  if (url.pathname === '/oauth/forgejo/login/start') return login?.startBrowser(request)
  if (url.pathname === '/oauth/forgejo/login/callback') return login?.callback(request)
  if (url.pathname === OAUTH_START_PATH) return oauth?.handleStart(url)
  if (url.pathname === OAUTH_CALLBACK_PATH && oauth) {
    const response = await oauth.handleCallback(request)
    return login ? login.finishForgejo(request, response) : response
  }
  return undefined
}

if (config.transport === 'stdio') {
  void serveStdio(factory)
  console.error('forgejo_workflow MCP running on stdio')
} else {
  await serveHttp(factory, config.http, browserRoutes)
}
