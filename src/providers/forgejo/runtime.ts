import { EncryptedFileStore } from '../../core/encrypted-file-store.js'
import { ProviderApplication } from '../../core/provider.js'
import { buildBrowserRoutes, buildLoginFlow, runTransport } from '../../core/runtime.js'
import { loadConfig } from './config.js'
import { definition } from './definition.js'
import { ForgejoClient } from './forgejo.js'
import { ProviderOAuth } from './provider-oauth.js'
import { createForgejoServer } from './server.js'

export class Provider extends ProviderApplication {
  readonly definition = definition

  async start(env: NodeJS.ProcessEnv): Promise<void> {
    const config = loadConfig(env)
    const forgejo = new ForgejoClient(config.forgejo)
    const oauth = config.providerOAuth
      ? new ProviderOAuth({ publicUrl: config.providerOAuth.publicUrl, internalUrl: config.forgejo.baseUrl, redirectUrl: config.providerOAuth.redirectUrl, clientId: config.providerOAuth.clientId, clientSecret: config.providerOAuth.clientSecret, store: new EncryptedFileStore(config.providerOAuth.storePath, config.providerOAuth.encryptionKey) })
      : undefined
    const login = buildLoginFlow(definition, config, config.forgejoLoginClientId, oauth, config.providerOAuth?.redirectUrl)
    const factory = () => createForgejoServer(forgejo, config.writesEnabled, config.transport === 'http', oauth)
    const browserRoutes = buildBrowserRoutes({ provider: definition, config, ...(login ? { login } : {}), ...(oauth ? { oauth } : {}) })
    await runTransport(definition, config, factory, browserRoutes)
  }
}
