import { createRemoteJWKSet, jwtVerify } from 'jose'
import { ProviderLoginFlow, type LoginFlowOptions } from '../../../shared/login-flow.js'
import type { ForgejoOAuth } from './forgejo-oauth.js'

type Options = Omit<LoginFlowOptions, 'routePrefix' | 'cookieName' | 'providerName' | 'provider' | 'verifyIdentity'> & { forgejo: ForgejoOAuth }

export class ForgejoLoginFlow extends ProviderLoginFlow {
  constructor({ forgejo, ...options }: Options) {
    const issuer = options.issuer.toString().replace(/\/$/, '')
    const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`))
    super({
      ...options, provider: forgejo, providerName: 'Forgejo', routePrefix: '/oauth/forgejo', cookieName: 'forgejo_mcp_login',
      verifyIdentity: async (token) => (await jwtVerify(token, jwks, { issuer, audience: options.clientId, algorithms: ['RS256'] })).payload
    })
  }

  finishForgejo(request: Request, response: Response): Response { return this.finishProvider(request, response) }
}
