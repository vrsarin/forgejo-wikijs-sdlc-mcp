import { createHash } from 'node:crypto'
import type { EncryptedFileStore, StoredGrant } from '../../core/encrypted-file-store.js'
import { boundedJson } from '../../core/fetch-json.js'
import { BaseProviderOAuth, type PendingProviderGrant } from '../../core/provider-oauth.js'
import { oauthPaths } from '../../core/provider.js'
import { definition } from './definition.js'
import { UPSTREAM_TIMEOUT_MS } from '../../core/config-util.js'

export interface ProviderOAuthOptions {
  publicUrl: string | URL
  internalUrl: string | URL
  callbackUrl: string | URL
  issuer: string
  store: EncryptedFileStore
  fetch?: typeof globalThis.fetch
  now?: () => number
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  ha_auth_provider?: string
}

const isTokenResponse = (value: unknown): value is TokenResponse => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const token = value as Record<string, unknown>
  return typeof token.access_token === 'string' && token.access_token.length > 0 &&
    typeof token.expires_in === 'number' && Number.isFinite(token.expires_in) && token.expires_in > 0 &&
    (token.refresh_token === undefined || typeof token.refresh_token === 'string') &&
    (token.ha_auth_provider === undefined || typeof token.ha_auth_provider === 'string')
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export class ProviderOAuth extends BaseProviderOAuth {
  protected readonly id = 'homeassistant'
  protected readonly label = 'Home Assistant'
  readonly #publicUrl: URL
  readonly #internalUrl: URL
  readonly #issuer: string

  constructor(options: ProviderOAuthOptions) {
    const publicUrl = new URL(options.publicUrl)
    const internalUrl = new URL(options.internalUrl)
    const redirectUrl = new URL(options.callbackUrl)
    if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash ||
        internalUrl.origin !== 'https://home-assistant-upstream-tls' || internalUrl.pathname !== '/' ||
        redirectUrl.origin !== 'http://localhost' || redirectUrl.pathname !== oauthPaths(definition).callback ||
        redirectUrl.search || redirectUrl.hash || redirectUrl.username || redirectUrl.password ||
        internalUrl.username || internalUrl.password || internalUrl.search || internalUrl.hash || !text(options.issuer)) {
      throw new Error('Invalid Home Assistant OAuth endpoint configuration')
    }
    super({ redirectUrl, store: options.store, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) })
    this.#publicUrl = publicUrl
    this.#internalUrl = internalUrl
    this.#issuer = options.issuer.replace(/\/$/, '')
  }

  protected authorizationUrl(state: string, _pending: PendingProviderGrant, challenge: string): URL {
    const authorize = new URL('/auth/authorize', this.#publicUrl)
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: 'http://localhost/', redirect_uri: this.redirectUrl.toString(), state,
      code_challenge: challenge, code_challenge_method: 'S256'
    }).toString()
    return authorize
  }

  protected async exchangeCode(code: string, pending: PendingProviderGrant): Promise<StoredGrant> {
    let tokens: TokenResponse | undefined
    try {
      tokens = await this.#token({
        grant_type: 'authorization_code', client_id: 'http://localhost/', code,
        code_verifier: pending.verifier, redirect_uri: this.redirectUrl.toString()
      })
      if (!text(tokens.refresh_token) || tokens.ha_auth_provider !== 'auth_oidc') {
        throw new Error('Home Assistant did not authorize through Keycloak')
      }
      await this.#verifyIdentity(pending.subject, tokens.access_token)
      return this.#grant(tokens, tokens.refresh_token)
    } catch (error) {
      if (text(tokens?.refresh_token)) await this.#revokeRejected(tokens.refresh_token)
      throw error
    }
  }

  protected async refreshGrant(grant: StoredGrant, subject: string): Promise<StoredGrant> {
    const tokens = await this.#token({ grant_type: 'refresh_token', client_id: 'http://localhost/', refresh_token: grant.refreshToken })
    await this.#verifyIdentity(subject, tokens.access_token)
    return this.#grant(tokens, tokens.refresh_token ?? grant.refreshToken)
  }

  protected async beforeDisconnect(grant: StoredGrant): Promise<void> { await this.#revoke(grant.refreshToken) }
  protected async afterStoreFailure(grant: StoredGrant): Promise<void> { await this.#revokeRejected(grant.refreshToken) }

  protected page(status: number, _title: string, message: string, headers: Record<string, string> = {}): Response {
    return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } })
  }

  #grant(tokens: TokenResponse, refreshToken: string): StoredGrant {
    return { accessToken: tokens.access_token, refreshToken, expiresAt: this.now + tokens.expires_in * 1000 }
  }

  async #token(body: Record<string, string>): Promise<TokenResponse> {
    // Home Assistant 401s do not prove that a stored refresh grant was revoked; preserve it for retry/diagnosis.
    return this.postForm(new URL('/auth/token', this.#internalUrl), body, 'Home Assistant token request failed', isTokenResponse, false)
  }

  async #verifyIdentity(subject: string, token: string): Promise<void> {
    const response = await this.fetcher(new URL('/api/sdlc-mcp/identity', this.#internalUrl), {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`Home Assistant identity verification failed (HTTP ${response.status})`)
    const result = await boundedJson(response) as { oidc_subject_hashes?: unknown }
    const expected = createHash('sha256').update(`${this.#issuer}.${subject}`).digest('hex')
    if (!Array.isArray(result.oidc_subject_hashes) || !result.oidc_subject_hashes.includes(expected)) {
      throw new Error('Home Assistant account does not match the Keycloak user')
    }
  }

  async #revoke(refreshToken: string): Promise<void> {
    const response = await this.fetcher(new URL('/auth/revoke', this.#internalUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken })
    })
    if (!response.ok) throw new Error(`Home Assistant grant revocation failed (HTTP ${response.status})`)
  }

  async #revokeRejected(refreshToken: string): Promise<void> {
    try { await this.#revoke(refreshToken) } catch {
      throw new Error('Home Assistant rejected grant could not be revoked')
    }
  }
}
