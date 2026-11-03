import { createRemoteJWKSet, jwtVerify } from 'jose'
import { ProviderLoginFlow, type LoginFlowOptions } from '../../../shared/login-flow.js'
import type { WikiJsOAuth } from './wikijs-oauth.js'

type Options = Omit<LoginFlowOptions, 'routePrefix' | 'cookieName' | 'providerName' | 'provider' | 'verifyIdentity'> & { wikiJs: WikiJsOAuth }

export class WikiJsLoginFlow extends ProviderLoginFlow {
  constructor({ wikiJs, ...options }: Options) {
    const issuer = options.issuer.toString().replace(/\/$/, '')
    const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`))
    super({
      ...options, provider: wikiJs, providerName: 'Wiki.js', routePrefix: '/oauth/wikijs', cookieName: 'wikijs_mcp_login',
      verifyIdentity: async (token) => (await jwtVerify(token, jwks, { issuer, audience: options.clientId, algorithms: ['RS256'] })).payload
    })
  }
}
