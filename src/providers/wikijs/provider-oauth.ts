import type { EncryptedFileStore, StoredGrant } from '../../core/encrypted-file-store.js'
import { BaseProviderOAuth, type PendingProviderGrant } from '../../core/provider-oauth.js'
import { UPSTREAM_TIMEOUT_MS } from '../../core/config-util.js'

export interface ProviderOAuthOptions {
  wikiOrigin: URL
  redirectUrl: URL
  scopes: string
  store: EncryptedFileStore<WikiStateExtension>
  fetch?: typeof globalThis.fetch
  now?: () => number
}

interface TokenResponse { access_token: string; refresh_token: string; expires_in: number; scope?: string }
const isTokenResponse = (value: unknown): value is TokenResponse => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const token = value as Record<string, unknown>
  return typeof token.access_token === 'string' && token.access_token.length > 0 && typeof token.refresh_token === 'string' &&
    token.refresh_token.length > 0 && typeof token.expires_in === 'number' && Number.isFinite(token.expires_in) && token.expires_in > 0 &&
    (token.scope === undefined || typeof token.scope === 'string')
}
interface StoredClient { clientId: string; redirectUri: string; origin: string }
export interface WikiStateExtension { client?: StoredClient }

export class ProviderOAuth extends BaseProviderOAuth<WikiStateExtension> {
  protected readonly id = 'wikijs'
  protected readonly label = 'Wiki.js'
  readonly #options: ProviderOAuthOptions
  #registering: Promise<StoredClient> | undefined

  constructor(options: ProviderOAuthOptions) { super(options); this.#options = options }

  get #origin(): string { return this.#options.wikiOrigin.origin }
  get #resource(): string { return `${this.#origin}/_mcp` }

  protected async authorizationUrl(state: string, _pending: PendingProviderGrant, challenge: string): Promise<URL> {
    const client = await this.#client()
    const authorize = new URL('/_oauth/authorize', this.#origin)
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUri, state,
      code_challenge: challenge, code_challenge_method: 'S256', scope: this.#options.scopes, resource: this.#resource
    }).toString()
    return authorize
  }

  protected async exchangeCode(code: string, pending: PendingProviderGrant): Promise<StoredGrant> {
    const client = await this.#client()
    return this.#grant(await this.#token({
      grant_type: 'authorization_code', code, code_verifier: pending.verifier,
      client_id: client.clientId, redirect_uri: client.redirectUri, resource: this.#resource
    }))
  }

  protected async refreshGrant(grant: StoredGrant): Promise<StoredGrant> {
    const client = (await this.loadState()).client
    if (!client) throw this.reject('Wiki.js client registration is unavailable')
    return this.#grant(await this.#token({ grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: client.clientId }))
  }

  #grant(tokens: TokenResponse): StoredGrant {
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: this.now + tokens.expires_in * 1000, scope: tokens.scope ?? this.#options.scopes }
  }

  async #token(form: Record<string, string>): Promise<TokenResponse> {
    return this.postForm(new URL('/_oauth/token', this.#origin), form, 'Wiki.js token endpoint failed', isTokenResponse)
  }

  async #client(): Promise<StoredClient> {
    const existing = (await this.loadState()).client
    const redirectUri = this.redirectUrl.toString()
    if (existing && existing.origin === this.#origin && existing.redirectUri === redirectUri) return existing
    return (this.#registering ??= this.#registerClient(redirectUri).finally(() => { this.#registering = undefined }))
  }

  async #registerClient(redirectUri: string): Promise<StoredClient> {
    const response = await this.fetcher(new URL('/_oauth/register', this.#origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_name: 'Wiki.js SDLC MCP', redirect_uris: [redirectUri] })
    })
    const body = await response.json().catch(() => undefined) as { client_id?: string; error_description?: string } | undefined
    if (!response.ok || !body?.client_id) throw new Error(`Wiki.js refused client registration: ${body?.error_description ?? `HTTP ${response.status}`}`)
    const client = { clientId: body.client_id, redirectUri, origin: this.#origin }
    await this.mutateState((state) => { state.client = client; state.grants = {} })
    return client
  }
}
