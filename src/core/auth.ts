import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier
} from '@modelcontextprotocol/server'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import type { OidcAuthConfig } from './config.js'

export type { OidcAuthConfig } from './config.js'

export interface VerifiedCaller { subject: string; discovery: boolean }

export function toCaller(info: AuthInfo): VerifiedCaller {
  const subject = info.extra?.subject
  if (typeof subject !== 'string' || !subject) throw new Error('Token has no subject')
  return { subject, discovery: info.extra?.discovery === true }
}

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function hasClientRole(payload: JWTPayload, clientId: string, role: string): boolean {
  const access = payload.resource_access
  if (!access || typeof access !== 'object' || Array.isArray(access)) return false
  const client = (access as Record<string, unknown>)[clientId]
  if (!client || typeof client !== 'object' || Array.isArray(client)) return false
  const roles = (client as Record<string, unknown>).roles
  return Array.isArray(roles) && roles.includes(role)
}

function hasRealmRole(payload: JWTPayload, role: string): boolean {
  const access = payload.realm_access
  if (!access || typeof access !== 'object' || Array.isArray(access)) return false
  const roles = (access as Record<string, unknown>).roles
  return Array.isArray(roles) && roles.includes(role)
}

export class OidcJwtVerifier implements OAuthTokenVerifier {
  readonly #config: OidcAuthConfig
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(config: OidcAuthConfig) {
    this.#config = config
    this.#jwks = createRemoteJWKSet(new URL(`${config.issuer.toString().replace(/\/$/, '')}/protocol/openid-connect/certs`))
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload } = await jwtVerify(token, this.#jwks, {
        issuer: this.#config.issuer.toString().replace(/\/$/, ''),
        audience: [this.#config.audience, ...(this.#config.additionalAudiences ?? [])],
        algorithms: ['RS256']
      })
      if (!payload.sub || !payload.exp) throw new Error('Token is missing subject or expiration')
      const hasRequiredRole = this.#config.requiredRealmRole
        ? hasRealmRole(payload, this.#config.requiredRealmRole)
        : this.#config.roleClientId !== undefined && hasClientRole(payload, this.#config.roleClientId, this.#config.requiredRole)
      const discovery = this.#config.discoveryClientId !== undefined &&
        stringClaim(payload, 'azp') === this.#config.discoveryClientId
      const hasRequiredGroup = !this.#config.requiredGroup ||
        (Array.isArray(payload.groups) && payload.groups.includes(this.#config.requiredGroup))
      if (discovery ? !hasRealmRole(payload, 'mcp-discovery') : !hasRequiredRole || !hasRequiredGroup) {
        throw new Error('Token does not grant the required MCP role')
      }
      const username = stringClaim(payload, 'preferred_username') ?? payload.sub
      const scopes = (stringClaim(payload, 'scope') ?? '').split(' ').filter(Boolean)
      return {
        token,
        clientId: username,
        scopes,
        expiresAt: payload.exp,
        resource: this.#config.resource,
        extra: { subject: payload.sub, authorizedParty: stringClaim(payload, 'azp'), audience: payload.aud, discovery }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Access token validation failed'
      throw new OAuthError(OAuthErrorCode.InvalidToken, message)
    }
  }
}
