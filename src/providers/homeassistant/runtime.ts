import { readFileSync } from 'node:fs'
import { OidcJwtVerifier, toCaller } from '../../core/auth.js'
import { loadCoreConfig, type HttpAuthConfig, type OidcAuthConfig } from '../../core/config.js'
import { parseEncryptionKey } from '../../core/config-util.js'
import { EncryptedFileStore } from '../../core/encrypted-file-store.js'
import { oauthPaths, ProviderApplication } from '../../core/provider.js'
import { serveWebHandler } from '../../core/web-runtime.js'
import { createHomeAssistantApp } from './app.js'
import { definition } from './definition.js'
import { ProviderOAuth } from './provider-oauth.js'

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function requireHomeAssistantOidc(auth: HttpAuthConfig): OidcAuthConfig {
  if (auth.mode !== 'oidc') throw new Error('Home Assistant requires ENABLE_OIDC=true')
  if (!auth.requiredGroup) throw new Error('Home Assistant requires MCP_OIDC_REQUIRED_GROUP')
  if (!auth.discoveryClientId) throw new Error('Home Assistant requires MCP_OIDC_DISCOVERY_CLIENT_ID')
  return auth
}

export class Provider extends ProviderApplication {
  readonly definition = definition

  async start(env: NodeJS.ProcessEnv): Promise<void> {
    const config = loadCoreConfig(env)
    if (config.transport !== 'http') throw new Error('Home Assistant supports only the HTTP transport')
    const auth = requireHomeAssistantOidc(config.http.auth)
    const discoverySubject = readFileSync(required(env, 'HOMEASSISTANT_DISCOVERY_SUBJECT_FILE'), 'utf8').trim()
    if (!/^[0-9a-f-]{36}$/i.test(discoverySubject)) throw new Error('Home Assistant discovery subject is invalid')
    const upstream = required(env, 'HOMEASSISTANT_INTERNAL_URL')
    const oauth = new ProviderOAuth({
      publicUrl: required(env, 'HOMEASSISTANT_PUBLIC_URL'), internalUrl: upstream,
      callbackUrl: env.HOMEASSISTANT_OAUTH_REDIRECT_URL ?? new URL(oauthPaths(definition).callback, 'http://localhost').toString(),
      issuer: auth.issuer.toString(),
      store: new EncryptedFileStore(env.HOMEASSISTANT_TOKEN_STORE_PATH ?? '/data/homeassistant-grants.enc', parseEncryptionKey(env, 'HOMEASSISTANT_TOKEN_ENCRYPTION_KEY'))
    })
    const oidc = new OidcJwtVerifier(auth)
    const app = createHomeAssistantApp({
      verifier: { verify: async (token) => toCaller(await oidc.verifyAccessToken(token)) },
      oauth, discoverySubject, upstream, allowedHosts: config.http.allowedHosts
    })
    await serveWebHandler(app, { host: config.http.host, port: config.http.port, name: definition.runtimeName, env })
  }
}
