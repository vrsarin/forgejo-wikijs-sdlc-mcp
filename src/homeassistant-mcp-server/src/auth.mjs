import { createRemoteJWKSet, jwtVerify } from 'jose'

export class HomeAssistantVerifier {
  #issuer
  #audience
  #discoveryClient
  #jwks

  constructor({ issuer, audience, discoveryClient, jwks }) {
    if (!issuer || !audience || !discoveryClient) throw new Error('Home Assistant OIDC issuer, audience, and discovery client are required')
    this.#issuer = issuer.replace(/\/$/, '')
    this.#audience = audience
    this.#discoveryClient = discoveryClient
    this.#jwks = jwks ?? createRemoteJWKSet(new URL(`${this.#issuer}/protocol/openid-connect/certs`))
  }

  async verify(token) {
    const { payload } = await jwtVerify(token, this.#jwks, {
      issuer: this.#issuer, audience: this.#audience, algorithms: ['RS256']
    })
    if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.exp !== 'number') throw new Error('Token has no subject or expiry')
    const roles = payload.realm_access?.roles
    if (!Array.isArray(roles)) throw new Error('Token has no realm roles')
    const discovery = payload.azp === this.#discoveryClient
    if (discovery) {
      if (!roles.includes('mcp-discovery')) throw new Error('Discovery role is required')
    } else if (!roles.includes('mcp-user') || !Array.isArray(payload.groups) || !payload.groups.includes('home-assistant-users')) {
      throw new Error('Home Assistant group and MCP role are required')
    }
    return {
      subject: payload.sub, discovery,
      username: typeof payload.preferred_username === 'string' ? payload.preferred_username : payload.sub
    }
  }
}
