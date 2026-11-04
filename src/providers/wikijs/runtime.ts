import { EncryptedFileStore } from '../../core/encrypted-file-store.js'
import { ProviderApplication } from '../../core/provider.js'
import { buildBrowserRoutes, buildLoginFlow, runTransport } from '../../core/runtime.js'
import { loadConfig } from './config.js'
import { definition } from './definition.js'
import { ProviderOAuth } from './provider-oauth.js'
import { createWikiJsSdlcServer } from './server.js'
import { beginWikiSso } from './wiki-sso.js'
import { WikiJsClient } from './wikijs.js'

export class Provider extends ProviderApplication {
  readonly definition = definition

  async start(env: NodeJS.ProcessEnv): Promise<void> {
    const config = loadConfig(env)
    const wikiJs = config.wikiJsMcpUrl ? new WikiJsClient({ mcpUrl: config.wikiJsMcpUrl }) : undefined
    const oauth = config.providerOAuth && config.wikiJsMcpUrl
      ? new ProviderOAuth({ wikiOrigin: config.wikiJsMcpUrl, redirectUrl: config.providerOAuth.redirectUrl, scopes: config.providerOAuth.scopes, store: new EncryptedFileStore(config.providerOAuth.storePath, config.providerOAuth.encryptionKey) })
      : undefined
    const login = buildLoginFlow(definition, config, config.wikiJsLoginClientId, oauth, config.providerOAuth?.redirectUrl)
    const factory = () => createWikiJsSdlcServer(config.wikiJsMcpUrl, wikiJs, oauth, config.wikiJsToken)
    const wikiSso = config.providerOAuth && config.wikiJsMcpUrl
      ? { wikiUrl: config.wikiJsMcpUrl, callbackUrl: config.providerOAuth.redirectUrl }
      : undefined
    const extra = login && wikiSso
      ? async (request: Request) => new URL(request.url).pathname === '/_authorize'
        ? beginWikiSso(request, wikiSso)
        : undefined
      : undefined
    const browserRoutes = buildBrowserRoutes({ provider: definition, config, ...(login ? { login } : {}), ...(oauth ? { oauth } : {}), ...(extra ? { extra } : {}) })
    await runTransport(definition, config, factory, browserRoutes)
  }
}
