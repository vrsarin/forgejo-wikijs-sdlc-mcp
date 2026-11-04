import type { EncryptedFileStore, StoredGrant } from '../../core/encrypted-file-store.js'
import { BaseProviderOAuth, type PendingProviderGrant } from '../../core/provider-oauth.js'

export interface ProviderOAuthOptions {
  publicUrl: URL
  internalUrl: URL
  redirectUrl: URL
  clientId: string
  clientSecret: string
  store: EncryptedFileStore
  fetch?: typeof globalThis.fetch
  now?: () => number
}

interface TokenResponse { access_token: string; refresh_token?: string; expires_in?: number }
const isTokenResponse = (value: unknown): value is TokenResponse => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const token = value as Record<string, unknown>
  return typeof token.access_token === 'string' && token.access_token.length > 0 &&
    (token.refresh_token === undefined || typeof token.refresh_token === 'string') &&
    (token.expires_in === undefined || (typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)))
}
const withBase = (base: URL, path: string) => new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base.origin)

export class ProviderOAuth extends BaseProviderOAuth {
  protected readonly id = 'forgejo'
  protected readonly label = 'Forgejo'
  readonly #options: ProviderOAuthOptions

  constructor(options: ProviderOAuthOptions) { super(options); this.#options = options }

  protected authorizationUrl(state: string, _pending: PendingProviderGrant, challenge: string): URL {
    const authorize = withBase(this.#options.publicUrl, '/login/oauth/authorize')
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: this.#options.clientId, redirect_uri: this.redirectUrl.toString(), state,
      code_challenge: challenge, code_challenge_method: 'S256'
    }).toString()
    return authorize
  }

  protected async exchangeCode(code: string, pending: PendingProviderGrant): Promise<StoredGrant> {
    return this.#grant(await this.#token({ grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: this.redirectUrl.toString() }))
  }

  protected async refreshGrant(grant: StoredGrant): Promise<StoredGrant> {
    return this.#grant(await this.#token({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }), grant.refreshToken)
  }

  #grant(tokens: TokenResponse, previousRefresh = ''): StoredGrant {
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? previousRefresh, expiresAt: this.now + (tokens.expires_in ?? 3600) * 1000, scope: '' }
  }

  async #token(form: Record<string, string>): Promise<TokenResponse> {
    return this.postForm(withBase(this.#options.internalUrl, '/login/oauth/access_token'),
      { ...form, client_id: this.#options.clientId, client_secret: this.#options.clientSecret }, 'Forgejo token endpoint failed', isTokenResponse)
  }
}
